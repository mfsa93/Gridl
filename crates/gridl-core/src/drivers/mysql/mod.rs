//! MySQL and MariaDB through sqlx. Reads use the text protocol, like the
//! mysql client, so values arrive as the server prints them.

mod backup;
mod catalog;
mod connect;
mod literal;
mod objects;
mod query;

use std::path::Path;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::mysql::{MySqlDatabaseError, MySqlPool};
use sqlx::{Connection, Executor, MySql};

use super::common::bind::bound;
use super::common::cancel::interruptible;
use super::common::session::{Close, Pinned, Sessions};
use super::common::{batch_err, db_err, elapsed_ms, result};
use crate::driver::{ChunkSink, DatabaseDriver, ToolAccess};
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::types::{
    BatchRequest, BatchResult, ConnectionConfig, ConnectionId, DatabaseEngine, ForeignKey,
    QueryRequest, QueryResult, RelationRef, SqlCheck, SqlProblem, TableSchema,
};

/// One open database: a pool for catalog reads and batches, and the pinned connections.
struct Session {
    pool: MySqlPool,
    pinned: Pinned<query::Pinned>,
    /// `DATABASE()` of the session. The catalog shows only this schema.
    database: String,
    mariadb: bool,
}

#[async_trait]
impl Close for Session {
    async fn close(&self) {
        self.pinned.clear();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.pool.close()).await;
    }
}

pub struct MysqlDriver {
    sessions: Sessions<Session>,
}

impl MysqlDriver {
    pub fn new() -> Self {
        Self { sessions: Sessions::new() }
    }
}

impl Default for MysqlDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for MysqlDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Mysql
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let pool = connect::open_pool(config, password, endpoint.as_ref(), 8).await?;
        let (database, version) = connect::server_identity(&pool).await?;
        let mariadb = connect::is_mariadb(&version);
        let session = Session { pool, pinned: Pinned::new(), database, mariadb };
        self.sessions.open(&config.connection_id()?, session)
    }

    async fn probe(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        let pool = connect::open_pool(config, password, endpoint.as_ref(), 1).await?;
        let identity = connect::server_identity(&pool).await;
        pool.close().await;
        let (_, version) = identity?;
        let product = if connect::is_mariadb(&version) { "MariaDB" } else { "MySQL" };
        Ok(format!("{product} {version}"))
    }

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError> {
        self.sessions.close(id)
    }

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError> {
        let session = self.sessions.get(id)?;
        catalog::relations(&session.pool, &session.database).await
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        let session = self.sessions.get(id)?;
        let schema = relation.schema.as_deref().unwrap_or(&session.database);
        catalog::describe(&session.pool, schema, session.mariadb, relation).await
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        let session = self.sessions.get(id)?;
        catalog::all(&session.pool, &session.database, session.mariadb).await
    }

    async fn table_objects(
        &self,
        id: &ConnectionId,
        table: &RelationRef,
    ) -> Result<Vec<TableSchema>, CoreError> {
        let session = self.sessions.get(id)?;
        let schema = table.schema.as_deref().unwrap_or(&session.database);
        catalog::table_objects(&session.pool, schema, session.mariadb, &table.name).await
    }

    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError> {
        let session = self.sessions.get(id)?;
        catalog::foreign_keys(&session.pool, &session.database).await
    }

    async fn query(
        &self,
        id: &ConnectionId,
        request: &QueryRequest,
        sink: &mut dyn ChunkSink,
    ) -> Result<QueryResult, CoreError> {
        let started = Instant::now();
        if request.cancelled() {
            return result::cancelled(sink, request, started).await;
        }
        let session = self.sessions.get(id)?;
        let mut pinned = session.pinned.slot(request.browse).lock().await;
        if pinned.is_none() {
            *pinned = Some(query::Pinned::acquire(&session.pool).await?);
        }
        let Some(current) = pinned.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let thread_id = current.thread_id;
        let work = query::run(&mut current.connection, request, sink, started);
        let stop = query::kill_query(&session.pool, thread_id);
        let (outcome, stopped) = interruptible(work, &request.cancel, stop).await;
        let cancelled = request.cancelled();
        if cancelled {
            // A stream dropped mid-result leaves rows on the wire. Stop the
            // statement, then resync so the next query does not drain them.
            if !stopped {
                query::kill_query(&session.pool, thread_id).await;
            }
            if !query::resync(&mut current.connection).await {
                *pinned = None;
            }
        } else if outcome.is_err() && current.connection.ping().await.is_err() {
            *pinned = None;
        }
        drop(pinned);
        match outcome {
            Err(_) if cancelled => result::cancelled(sink, request, started).await,
            other => other,
        }
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.sessions.get(id)?.pool.clone();
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = (&mut *connection).describe(sql).await else {
            return Ok(SqlCheck::clean());
        };
        if query::is_unsupported_ps(&err) {
            return Ok(SqlCheck::unknown());
        }
        let Some(db) =
            err.as_database_error().and_then(|db| db.try_downcast_ref::<MySqlDatabaseError>())
        else {
            return Err(db_err(err));
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position: None,
            code: Some(db.number().to_string()),
        }))
    }

    async fn backup(
        &self,
        _id: &ConnectionId,
        access: &ToolAccess<'_>,
        out: &Path,
    ) -> Result<(), CoreError> {
        backup::dump(access, out).await
    }

    async fn restore(
        &self,
        _id: &ConnectionId,
        access: &ToolAccess<'_>,
        input: &Path,
    ) -> Result<(), CoreError> {
        backup::load(access, input).await
    }

    async fn execute_batch_observed(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
        progress: &(dyn Fn(usize) + Send + Sync),
    ) -> Result<BatchResult, CoreError> {
        let started = Instant::now();
        let pool = self.sessions.get(id)?.pool.clone();
        let mut transaction = pool.begin().await.map_err(db_err)?;
        let mut rows_affected = 0;
        for (index, statement) in batch.statements.iter().enumerate() {
            let done = bound::<MySql>(&statement.sql, &statement.params)?
                .execute(&mut *transaction)
                .await
                .map_err(|err| batch_err(index, &err))?;
            rows_affected += done.rows_affected();
            progress(index + 1);
        }
        transaction.commit().await.map_err(db_err)?;
        Ok(BatchResult {
            statements: batch.statements.len() as u64,
            rows_affected,
            duration_ms: elapsed_ms(started),
        })
    }
}

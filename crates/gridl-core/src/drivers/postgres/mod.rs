//! PostgreSQL through sqlx. Reads use the simple protocol so every value
//! arrives as text, printed by its type's own output function.

mod backup;
mod catalog;
mod connect;
mod literal;
mod objects;
mod query;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::postgres::{PgDatabaseError, PgErrorPosition, PgPool};
use sqlx::{Connection, Executor, Postgres};

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

/// Labels of every enum type, by (schema, type name).
type EnumLabels = HashMap<(String, String), Vec<String>>;

/// One open database: a pool for catalog reads and batches, the pinned
/// connections, and enum labels cached since the last introspection.
struct Session {
    pool: PgPool,
    pinned: Pinned<query::Pinned>,
    enums: RwLock<Arc<EnumLabels>>,
}

impl Session {
    fn enums(&self) -> Result<Arc<EnumLabels>, CoreError> {
        Ok(Arc::clone(&*self.enums.read().map_err(|_| CoreError::LockPoisoned)?))
    }

    fn set_enums(&self, labels: EnumLabels) -> Result<(), CoreError> {
        *self.enums.write().map_err(|_| CoreError::LockPoisoned)? = Arc::new(labels);
        Ok(())
    }
}

#[async_trait]
impl Close for Session {
    async fn close(&self) {
        self.pinned.clear();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.pool.close()).await;
    }
}

pub struct PostgresDriver {
    sessions: Sessions<Session>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self { sessions: Sessions::new() }
    }

    fn pool(&self, id: &ConnectionId) -> Result<PgPool, CoreError> {
        Ok(self.sessions.get(id)?.pool.clone())
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Postgres
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let pool = connect::open_pool(config, password, endpoint.as_ref(), 8).await?;
        let enums = catalog::enum_labels(&pool).await?;
        let session = Session { pool, pinned: Pinned::new(), enums: RwLock::new(Arc::new(enums)) };
        self.sessions.open(&config.connection_id()?, session)
    }

    async fn probe(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        let pool = connect::open_pool(config, password, endpoint.as_ref(), 1).await?;
        let version = sqlx::query_scalar("SELECT version()").fetch_one(&pool).await;
        pool.close().await;
        version.map_err(db_err)
    }

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError> {
        self.sessions.close(id)
    }

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError> {
        catalog::relations(&self.pool(id)?).await
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        catalog::describe(&self.pool(id)?, relation).await
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        let session = self.sessions.get(id)?;
        let pool = &session.pool;
        // Independent catalog reads, run side by side on the pool.
        let ((mut tables, enums), objects) =
            tokio::try_join!(catalog::tables(pool), objects::all(pool))?;
        session.set_enums(enums)?;
        tables.extend(objects);
        Ok(tables)
    }

    async fn table_objects(
        &self,
        id: &ConnectionId,
        table: &RelationRef,
    ) -> Result<Vec<TableSchema>, CoreError> {
        let schema = table.schema.as_deref().unwrap_or("public");
        objects::table_objects(&self.pool(id)?, Some((schema, &table.name))).await
    }

    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError> {
        catalog::foreign_keys(&self.pool(id)?).await
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
        let enums = session.enums()?;
        let mut pinned = session.pinned.slot(request.browse).lock().await;
        if pinned.is_none() {
            *pinned = Some(query::Pinned::acquire(&session.pool).await?);
        }
        let Some(current) = pinned.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let pid = current.pid;
        let work = query::run(&mut current.connection, request, sink, &enums, started);
        let stop = query::cancel_backend(&session.pool, pid);
        let (outcome, stopped) = interruptible(work, &request.cancel, stop).await;
        let cancelled = request.cancelled();
        if cancelled && !stopped {
            // A stream dropped mid-result leaves the backend sending rows.
            query::cancel_backend(&session.pool, pid).await;
        }
        if (cancelled || outcome.is_err()) && current.connection.ping().await.is_err() {
            *pinned = None;
        }
        drop(pinned);
        match outcome {
            Err(_) if cancelled => result::cancelled(sink, request, started).await,
            other => other,
        }
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.pool(id)?;
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = connection.prepare(sql).await else {
            return Ok(SqlCheck::clean());
        };
        let Some(db) =
            err.as_database_error().and_then(|db| db.try_downcast_ref::<PgDatabaseError>())
        else {
            return Err(db_err(err));
        };
        // Untyped parameters are valid SQL the server just cannot type yet.
        if db.code() == "42P18" {
            return Ok(SqlCheck::unknown());
        }
        let position = match db.position() {
            Some(PgErrorPosition::Original(position)) => u32::try_from(position).ok(),
            _ => None,
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position,
            code: Some(db.code().to_owned()),
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
        let pool = self.pool(id)?;
        let mut transaction = pool.begin().await.map_err(db_err)?;
        let mut rows_affected = 0;
        for (index, statement) in batch.statements.iter().enumerate() {
            let done = bound::<Postgres>(&statement.sql, &statement.params)?
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

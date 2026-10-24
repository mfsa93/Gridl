//! SQLite through sqlx. The database is a file; there is no server to cancel.

mod catalog;
mod connect;
mod query;

use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use sqlx::pool::PoolConnection;
use sqlx::{Connection, Executor, Sqlite, SqlitePool};

use super::common::bind::bound;
use super::common::session::{Close, Pinned, Sessions};
use super::common::{batch_err, db_err, elapsed_ms, result};
use crate::driver::{ChunkSink, DatabaseDriver, ToolAccess};
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::{
    BatchRequest, BatchResult, ConnectionConfig, ConnectionId, DatabaseEngine, ForeignKey,
    QueryRequest, QueryResult, RelationRef, SqlCheck, SqlProblem, TableSchema,
};

/// One open database file: a pool for catalog reads and batches, and the
/// connections kept for the editor and the table browser.
struct Session {
    pool: SqlitePool,
    pinned: Pinned<PoolConnection<Sqlite>>,
}

#[async_trait]
impl Close for Session {
    async fn close(&self) {
        self.pinned.clear();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), self.pool.close()).await;
    }
}

pub struct SqliteDriver {
    sessions: Sessions<Session>,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self { sessions: Sessions::new() }
    }

    fn pool(&self, id: &ConnectionId) -> Result<SqlitePool, CoreError> {
        Ok(self.sessions.get(id)?.pool.clone())
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Sqlite
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        _password: Option<&SecretString>,
        _endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let pool = connect::open_pool(config, 4).await?;
        let session = Session { pool, pinned: Pinned::new() };
        self.sessions.open(&config.connection_id()?, session)
    }

    async fn probe(
        &self,
        config: &ConnectionConfig,
        _password: Option<&SecretString>,
        _endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        let pool = connect::open_pool(config, 1).await?;
        let version = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await;
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
        let pool = self.pool(id)?;
        let mut tables = Vec::new();
        for relation in catalog::relations(&pool).await? {
            tables.push(catalog::describe(&pool, &relation).await?);
        }
        Ok(tables)
    }

    async fn table_objects(
        &self,
        id: &ConnectionId,
        table: &RelationRef,
    ) -> Result<Vec<TableSchema>, CoreError> {
        catalog::table_objects(&self.pool(id)?, &table.name).await
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
        let mut pinned = session.pinned.slot(request.browse).lock().await;
        if pinned.is_none() {
            *pinned = Some(session.pool.acquire().await.map_err(db_err)?);
        }
        let Some(connection) = pinned.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let outcome = query::run(connection, request, sink, started).await;
        if outcome.is_err() && connection.ping().await.is_err() {
            *pinned = None;
        }
        outcome
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.pool(id)?;
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = connection.prepare(sql).await else {
            return Ok(SqlCheck::clean());
        };
        let Some(db) = err.as_database_error() else {
            return Err(db_err(err));
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position: None,
            code: db.code().map(|code| code.into_owned()),
        }))
    }

    /// `VACUUM INTO` writes a consistent copy of the file, even while it is in use.
    async fn backup(
        &self,
        id: &ConnectionId,
        _access: &ToolAccess<'_>,
        out: &Path,
    ) -> Result<(), CoreError> {
        let target = out.to_str().ok_or_else(|| {
            CoreError::Transfer(tr!("the path is not valid UTF-8", "la ruta no es UTF-8 válido"))
        })?;
        sqlx::query("VACUUM INTO ?1")
            .bind(target)
            .execute(&self.pool(id)?)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// A SQLite backup is a database file of its own.
    async fn restore(
        &self,
        _id: &ConnectionId,
        _access: &ToolAccess<'_>,
        _input: &Path,
    ) -> Result<(), CoreError> {
        Err(CoreError::Transfer(tr!(
            "To restore SQLite, open the backup file as a connection.",
            "Para restaurar un SQLite, abre el archivo de respaldo como conexión."
        )))
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
            let done = bound::<Sqlite>(&statement.sql, &statement.params)?
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

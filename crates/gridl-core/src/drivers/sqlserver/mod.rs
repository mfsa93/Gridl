//! Microsoft SQL Server and Azure SQL over TDS, with tiberius (sqlx has no
//! SQL Server driver). tiberius has no pool, so [`pool::Pool`] keeps a few
//! idle connections.

mod catalog;
mod connect;
mod decode;
mod lexer;
mod objects;
mod pool;
mod query;

use std::time::{Duration, Instant};

use async_trait::async_trait;
use tiberius::{Client, Query};
use tokio::net::TcpStream;
use tokio_util::compat::Compat;

use super::common::cancel::abandonable;
use super::common::session::{Close, Pinned, Sessions};
use super::common::{elapsed_ms, result};
use crate::driver::{ChunkSink, DatabaseDriver};
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::{
    BatchRequest, BatchResult, ConnectionConfig, ConnectionId, DatabaseEngine, ForeignKey,
    QueryRequest, QueryResult, RelationRef, SqlCheck, SqlProblem, TableSchema,
};
use connect::{error_text, server_err, simple};
use pool::Pool;

type MsClient = Client<Compat<TcpStream>>;

/// One open database: a pool for catalog reads and batches, and the pinned connections.
struct Session {
    pool: Pool,
    pinned: Pinned<MsClient>,
    /// SQL Server has no read-only session, so the driver refuses writes itself.
    read_only: bool,
}

#[async_trait]
impl Close for Session {
    /// Dropping the connections closes their sockets, which rolls back open transactions.
    async fn close(&self) {
        self.pinned.clear();
        if let Ok(mut idle) = self.pool.idle.lock() {
            idle.clear();
        }
    }
}

fn read_only_error() -> CoreError {
    CoreError::Database(tr!("the connection is read-only", "la conexión es de solo lectura"))
}

pub struct SqlserverDriver {
    sessions: Sessions<Session>,
}

impl SqlserverDriver {
    pub fn new() -> Self {
        Self { sessions: Sessions::new() }
    }
}

impl Default for SqlserverDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for SqlserverDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Sqlserver
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let pool = Pool::new(connect::config(config, password, endpoint.as_ref())?);
        // Connect once now so a wrong password fails here, not on the first query.
        let first = pool.open().await?;
        pool.put(first);
        let session = Session { pool, pinned: Pinned::new(), read_only: config.read_only };
        self.sessions.open(&config.connection_id()?, session)
    }

    async fn probe(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        let mut client =
            connect::open_client(connect::config(config, password, endpoint.as_ref())?).await?;
        let version = connect::server_version(&mut client).await;
        let _ = client.close().await;
        version
    }

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError> {
        self.sessions.close(id)
    }

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError> {
        catalog::relations(&self.sessions.get(id)?.pool).await
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        catalog::describe(&self.sessions.get(id)?.pool, relation).await
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        catalog::all(&self.sessions.get(id)?.pool).await
    }

    async fn table_objects(
        &self,
        id: &ConnectionId,
        table: &RelationRef,
    ) -> Result<Vec<TableSchema>, CoreError> {
        let schema = table.schema.as_deref().unwrap_or("dbo");
        objects::table_objects(&self.sessions.get(id)?.pool, Some((schema, &table.name))).await
    }

    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError> {
        catalog::foreign_keys(&self.sessions.get(id)?.pool).await
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
        if session.read_only && lexer::writes(&request.sql) {
            return Err(read_only_error());
        }
        let mut pinned = session.pinned.slot(request.browse).lock().await;
        if pinned.is_none() {
            *pinned = Some(session.pool.open().await?);
        }
        let Some(client) = pinned.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        // A cancel drops the running request; the server is told below.
        let outcome =
            abandonable(query::run(client, request, sink, started), &request.cancel).await;
        let interrupted = match &outcome {
            None => true,
            Some(Ok(done)) => done.cancelled || done.truncated,
            Some(Err(_)) => false,
        };
        if interrupted {
            // Stop the server and drop what it still had to send, so the
            // next query does not read through it first.
            let stopped =
                tokio::time::timeout(Duration::from_secs(10), client.cancel_query()).await;
            if !matches!(stopped, Ok(Ok(()))) {
                *pinned = None;
            }
        } else if let Some(Err(CoreError::Io(_))) = &outcome {
            *pinned = None;
        }
        drop(pinned);
        match outcome {
            Some(Err(_)) | None if request.cancelled() => {
                result::cancelled(sink, request, started).await
            }
            Some(other) => other,
            None => Err(CoreError::Cancelled),
        }
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let session = self.sessions.get(id)?;
        let (mut client, _) = session.pool.get().await?;
        // NOEXEC compiles without running: syntax and unknown columns are
        // reported, tables that do not exist yet are not (deferred resolution).
        simple(&mut client, "SET NOEXEC ON").await?;
        let checked = match client.simple_query(sql).await {
            Ok(stream) => stream.into_results().await.map(|_| ()),
            Err(err) => Err(err),
        };
        if simple(&mut client, "SET NOEXEC OFF").await.is_ok() {
            session.pool.put(client);
        }
        match checked {
            Ok(()) => Ok(SqlCheck::clean()),
            Err(tiberius::error::Error::Server(err)) => Ok(SqlCheck::failed(SqlProblem {
                message: err.message().to_owned(),
                position: query::line_offset(sql, err.line()),
                code: Some(err.code().to_string()),
            })),
            Err(err) => Err(server_err(err)),
        }
    }

    async fn execute_batch_observed(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
        progress: &(dyn Fn(usize) + Send + Sync),
    ) -> Result<BatchResult, CoreError> {
        let started = Instant::now();
        let session = self.sessions.get(id)?;
        if session.read_only {
            return Err(read_only_error());
        }
        // The connection is owned here: if the batch is dropped half way (time
        // limit), closing it rolls the transaction back.
        let (mut client, _) = session.pool.get().await?;
        client.begin_transaction().await.map_err(server_err)?;
        let mut rows_affected = 0;
        for (index, statement) in batch.statements.iter().enumerate() {
            let (sql, used) = lexer::number_params(&statement.sql, &statement.params)?;
            let mut query = Query::new(sql);
            query::bind_all(&mut query, &statement.params[..used]);
            match query.execute(&mut client).await {
                Ok(done) => rows_affected += done.total(),
                Err(err) => {
                    if client.rollback_transaction().await.is_ok() {
                        session.pool.put(client);
                    }
                    let message = error_text(&err);
                    return Err(CoreError::Statement { number: index + 1, message });
                }
            }
            progress(index + 1);
        }
        client.commit_transaction().await.map_err(server_err)?;
        session.pool.put(client);
        Ok(BatchResult {
            statements: batch.statements.len() as u64,
            rows_affected,
            duration_ms: elapsed_ms(started),
        })
    }
}

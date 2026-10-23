use async_trait::async_trait;

use crate::error::CoreError;
use crate::secret::SecretString;
use crate::types::ForeignKey;
use crate::types::{
    BatchRequest, BatchResult, ConnectionConfig, ConnectionId, DatabaseEngine, QueryRequest,
    QueryResult, RelationRef, RowChunk, SqlCheck, TableSchema,
};

/// Receives row blocks as the driver produces them.
///
/// Implementations must not buffer the whole result. The desktop shell sends
/// each chunk across the Tauri channel and returns.
#[async_trait]
pub trait ChunkSink: Send {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError>;
}

/// Async port implemented by every engine.
///
/// A driver owns its sessions, keyed by [`ConnectionConfig::id`]. `query`
/// streams chunks through `sink` and must not collect the full result before
/// the first `on_chunk` call. Every `query` on one session runs on the same
/// database connection, so `BEGIN`, `SET`, and temporary tables carry over
/// between calls.
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    fn engine(&self) -> DatabaseEngine;

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError>;

    /// Opens a short-lived session and returns the server version. It does not keep the pool.
    async fn probe(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError>;

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError>;

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError>;

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError>;

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError>;

    /// Every foreign key in the schemas the catalog shows, columns in key order.
    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError>;

    async fn query(
        &self,
        id: &ConnectionId,
        request: &QueryRequest,
        sink: &mut dyn ChunkSink,
    ) -> Result<QueryResult, CoreError>;

    /// Parses one statement on a pool connection without running it. It never
    /// touches the editor connection, so a parse error cannot abort an open
    /// transaction there.
    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError>;

    /// Runs every statement in one transaction on a connection other than the
    /// editor's. Nothing is committed if any statement fails.
    async fn execute_batch(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
    ) -> Result<BatchResult, CoreError> {
        self.execute_batch_observed(id, batch, &|_| {}).await
    }

    /// [`DatabaseDriver::execute_batch`] that calls `progress` with the number
    /// of statements done after each one, before the commit.
    async fn execute_batch_observed(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
        progress: &(dyn Fn(usize) + Send + Sync),
    ) -> Result<BatchResult, CoreError>;
}

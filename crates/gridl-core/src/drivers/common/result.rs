use std::time::Instant;

use super::elapsed_ms;
use super::stream::StreamOutcome;
use crate::driver::ChunkSink;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, QueryRequest, QueryResult, RowChunk};

/// The summary of a query whose rows went out through [`super::stream::emit_chunks`].
pub(crate) fn streamed(
    request: &QueryRequest,
    started: Instant,
    columns: Vec<ColumnDefinition>,
    outcome: &StreamOutcome,
    rows_affected: u64,
) -> QueryResult {
    QueryResult {
        query_id: request.query_id.clone(),
        columns,
        row_count: outcome.row_count,
        rows_affected,
        duration_ms: elapsed_ms(started),
        cancelled: outcome.cancelled,
        truncated: outcome.truncated,
    }
}

/// The summary of a query that returned no rows.
pub(crate) fn without_rows(
    request: &QueryRequest,
    started: Instant,
    rows_affected: u64,
    cancelled: bool,
) -> QueryResult {
    QueryResult {
        query_id: request.query_id.clone(),
        columns: Vec::new(),
        row_count: 0,
        rows_affected,
        duration_ms: elapsed_ms(started),
        cancelled,
        truncated: false,
    }
}

/// The empty last chunk that tells the UI a query without rows is over.
pub(crate) async fn emit_terminal(
    sink: &mut dyn ChunkSink,
    request: &QueryRequest,
) -> Result<(), CoreError> {
    sink.on_chunk(RowChunk {
        query_id: request.query_id.clone(),
        index: 0,
        columns: Vec::new(),
        rows: Vec::new(),
        last: true,
    })
    .await
}

/// Closes a query that was cancelled before or while it ran.
pub(crate) async fn cancelled(
    sink: &mut dyn ChunkSink,
    request: &QueryRequest,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    emit_terminal(sink, request).await?;
    Ok(without_rows(request, started, 0, true))
}

/// Closes a statement that ran and returned no rows.
pub(crate) async fn done(
    sink: &mut dyn ChunkSink,
    request: &QueryRequest,
    started: Instant,
    rows_affected: u64,
) -> Result<QueryResult, CoreError> {
    emit_terminal(sink, request).await?;
    Ok(without_rows(request, started, rows_affected, false))
}

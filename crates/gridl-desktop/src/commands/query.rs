//! Running SQL: streamed queries, batches in one transaction, cancellation and
//! the connection's time limit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use gridl_core::{
    tr, BatchRequest, BatchResult, BatchStatement, ChunkSink, CoreError, QueryRequest, QueryResult,
    RowChunk, SqlValue, DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use super::fail;
use super::guard::guard;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub connection_id: String,
    pub query_id: String,
    pub sql: String,
    pub params: Vec<SqlValue>,
    pub chunk_rows: Option<usize>,
    /// Rows to keep before the result counts as truncated. Capped at [`MAX_STREAM_ROWS`].
    #[serde(default)]
    pub max_rows: Option<u64>,
    /// The user confirmed a statement the safety policy asks about.
    #[serde(default)]
    pub authorized: bool,
    /// A table browser read, run apart from the SQL editor's connection.
    #[serde(default)]
    pub browse: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteBatchRequest {
    pub connection_id: String,
    pub statements: Vec<BatchStatement>,
    #[serde(default)]
    pub authorized: bool,
}

/// Sends each chunk to the window over the query's IPC channel.
struct ChannelSink(Channel<RowChunk>);

#[async_trait]
impl ChunkSink for ChannelSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.send(chunk).map_err(|err| CoreError::Delivery(err.to_string()))
    }
}

/// A query's cancel flag, registered under its id while the command runs.
pub(crate) struct CancelGuard<'a> {
    state: &'a AppState,
    query_id: String,
}

impl<'a> CancelGuard<'a> {
    /// Registers `cancel` for `query_id`, or fails when that query is already running.
    pub(crate) fn register(
        state: &'a AppState,
        query_id: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if !state.register_cancel(query_id, Arc::clone(cancel)).map_err(fail)? {
            return Err(tr!(
                "the query '{query_id}' is already running",
                "la consulta '{query_id}' ya se está ejecutando"
            ));
        }
        Ok(Self { state, query_id: query_id.to_owned() })
    }
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_cancel(&self.query_id);
    }
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, query_id: String) -> Result<bool, String> {
    state.cancel(&query_id).map_err(fail)
}

/// Runs SQL and pushes [`RowChunk`] values through `on_chunk` until the summary resolves.
#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    request: ExecuteQueryRequest,
    on_chunk: Channel<RowChunk>,
) -> Result<QueryResult, String> {
    run_query(&state, request, &mut ChannelSink(on_chunk)).await
}

pub(crate) async fn run_query(
    state: &AppState,
    request: ExecuteQueryRequest,
    sink: &mut dyn ChunkSink,
) -> Result<QueryResult, String> {
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
    guard(state, id.as_str(), &[request.sql.as_str()], request.authorized)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let _registered = CancelGuard::register(state, &request.query_id, &cancel)?;
    let query = QueryRequest::new(
        request.query_id,
        request.sql,
        request.params,
        request.chunk_rows.unwrap_or(DEFAULT_CHUNK_ROWS),
        request.max_rows.unwrap_or(MAX_STREAM_ROWS).clamp(1, MAX_STREAM_ROWS),
        Arc::clone(&cancel),
    )
    .map_err(fail)?;
    let query = if request.browse { query.browsing() } else { query };
    let timer = statement_timeout(state, id.as_str()).map(|seconds| Timer::start(seconds, cancel));
    let outcome = driver.query(&id, &query, sink).await;
    // Once the timer fires the result is partial at best, even when the
    // engine reports the interrupted statement as finished.
    if let Some(timer) = timer.filter(Timer::fired) {
        return Err(timeout_message(timer.seconds));
    }
    outcome.map_err(fail)
}

/// Applies statements in one transaction. On failure nothing is committed.
#[tauri::command]
pub async fn execute_batch(
    state: State<'_, AppState>,
    request: ExecuteBatchRequest,
) -> Result<BatchResult, String> {
    run_batch(&state, request).await
}

pub(crate) async fn run_batch(
    state: &AppState,
    request: ExecuteBatchRequest,
) -> Result<BatchResult, String> {
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
    let sql: Vec<&str> =
        request.statements.iter().map(|statement| statement.sql.as_str()).collect();
    guard(state, id.as_str(), &sql, request.authorized)?;
    let batch = BatchRequest::new(request.statements).map_err(fail)?;
    let work = driver.execute_batch(&id, &batch);
    match statement_timeout(state, id.as_str()) {
        // Dropping the unfinished batch drops its transaction, which rolls back.
        Some(seconds) => tokio::time::timeout(Duration::from_secs(u64::from(seconds)), work)
            .await
            .map_err(|_| timeout_message(seconds))?
            .map_err(fail),
        None => work.await.map_err(fail),
    }
}

/// The session's statement time limit, if it has one.
fn statement_timeout(state: &AppState, id: &str) -> Option<u32> {
    state.safety(id).ok().and_then(|safety| safety.timeout_secs).filter(|seconds| *seconds > 0)
}

pub(crate) fn timeout_message(seconds: u32) -> String {
    tr!(
        "The query exceeded the {seconds} s limit and was cancelled.",
        "La consulta superó el tiempo límite de {seconds} s y se canceló."
    )
}

/// Sets a query's cancel flag after the time limit. Dropping it stops the clock.
struct Timer {
    seconds: u32,
    fired: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Timer {
    fn start(seconds: u32, cancel: Arc<AtomicBool>) -> Self {
        let fired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(u64::from(seconds))).await;
            // A user cancel that came first keeps its own outcome.
            if !cancel.swap(true, Ordering::SeqCst) {
                flag.store(true, Ordering::SeqCst);
            }
        });
        Self { seconds, fired, task }
    }

    fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

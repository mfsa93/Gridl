//! A query streamed straight to a file in Rust, without holding the rows in the UI.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use gridl_core::{tr, ChunkSink, CoreError, ExportFormat, ExportWriter, QueryRequest, RowChunk};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, Window};

use crate::commands::export::export_path;
use crate::commands::guard::guard;
use crate::commands::query::CancelGuard;
use crate::commands::{elapsed_ms, fail};
use crate::state::AppState;
use crate::windows::emit_to_window;

/// Rows per chunk the driver hands to the file writer.
const EXPORT_CHUNK_ROWS: usize = 1_000;

/// Rows between `gridl-export-progress` events.
const EXPORT_PROGRESS_ROWS: u64 = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub connection_id: String,
    pub query_id: String,
    pub sql: String,
    pub format: ExportFormat,
    pub path: String,
    /// Already-quoted target of the INSERT statements. Unused for CSV and JSON.
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub authorized: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows: u64,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress<'a> {
    query_id: &'a str,
    rows: u64,
}

/// Counts the bytes that reach the file.
struct Counting<W> {
    inner: W,
    bytes: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

type FileWriter = ExportWriter<BufWriter<Counting<File>>>;

/// Writes each chunk to the file as it arrives and reports progress.
struct FileSink<'a> {
    writer: FileWriter,
    progress: &'a (dyn Fn(u64) + Send + Sync),
    next_progress: u64,
    cancel: Arc<AtomicBool>,
    /// A write failure. The query is cancelled so the driver resyncs its connection.
    failed: Option<std::io::Error>,
}

impl FileSink<'_> {
    fn write(&mut self, chunk: &RowChunk) -> std::io::Result<()> {
        if chunk.index == 0 {
            self.writer.begin(&chunk.columns)?;
        }
        for row in &chunk.rows {
            self.writer.write_row(row)?;
        }
        Ok(())
    }
}

#[async_trait]
impl ChunkSink for FileSink<'_> {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        if self.failed.is_some() {
            return Ok(());
        }
        if let Err(err) = self.write(&chunk) {
            self.failed = Some(err);
            self.cancel.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let rows = self.writer.rows();
        if rows >= self.next_progress {
            (self.progress)(rows);
            while self.next_progress <= rows {
                self.next_progress += EXPORT_PROGRESS_ROWS;
            }
        }
        Ok(())
    }
}

fn remove_partial(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Runs a query and streams every row into a CSV, JSON, or SQL file, without
/// the row cap of the grid. The partial file is deleted on error or cancel.
#[tauri::command]
pub async fn export_query(
    window: Window,
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let query_id = request.query_id.clone();
    let progress = move |rows: u64| {
        let payload = ExportProgress { query_id: &query_id, rows };
        emit_to_window(&app, &label, "gridl-export-progress", payload);
    };
    run_export(&state, request, &progress).await
}

pub(crate) async fn run_export(
    state: &AppState,
    request: ExportRequest,
    progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ExportResult, String> {
    let started = Instant::now();
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
    guard(state, id.as_str(), &[request.sql.as_str()], request.authorized)?;
    let path = export_path(&request.path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let _registered = CancelGuard::register(state, &request.query_id, &cancel)?;
    let query =
        QueryRequest::export(request.query_id, request.sql, EXPORT_CHUNK_ROWS, Arc::clone(&cancel))
            .map_err(fail)?;
    let file = File::create(&path).map_err(|err| {
        tr!("Couldn't create the file: {err}", "No se pudo crear el archivo: {err}")
    })?;
    let out = BufWriter::with_capacity(1024 * 1024, Counting { inner: file, bytes: 0 });
    let mut sink = FileSink {
        writer: ExportWriter::new(out, request.format, driver.engine(), &request.table),
        progress,
        next_progress: EXPORT_PROGRESS_ROWS,
        cancel,
        failed: None,
    };
    let outcome = driver.query(&id, &query, &mut sink).await;
    let finished = match (outcome, sink.failed.take()) {
        (_, Some(err)) => {
            Err(tr!("Couldn't write the file: {err}", "No se pudo escribir el archivo: {err}"))
        }
        (Err(err), None) => Err(fail(err)),
        (Ok(result), None) if result.cancelled => {
            Err(tr!("Export cancelled.", "Exportación cancelada."))
        }
        (Ok(_), None) => Ok(()),
    };
    if let Err(err) = finished {
        drop(sink);
        remove_partial(&path);
        return Err(err);
    }
    let rows = sink.writer.rows();
    progress(rows);
    let written = sink
        .writer
        .finish()
        .and_then(|out| out.into_inner().map_err(std::io::IntoInnerError::into_error))
        .and_then(|mut counting| counting.flush().map(|()| counting.bytes));
    match written {
        Ok(bytes) => Ok(ExportResult { rows, bytes, duration_ms: elapsed_ms(started) }),
        Err(err) => {
            remove_partial(&path);
            Err(tr!("Couldn't write the file: {err}", "No se pudo escribir el archivo: {err}"))
        }
    }
}

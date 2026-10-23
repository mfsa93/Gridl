//! Streaming export of a query to a file, and CSV import into a table.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, ChunkSink, ConnectionId, CoreError, CsvPreview, ExportFormat, ExportWriter,
    ImportPlan, QueryRequest, RowChunk,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, Window};

use crate::commands::{export_path, fail, guard, CancelGuard};
use crate::state::AppState;
use crate::windows::emit_to_window;

/// Rows per chunk the driver hands to the file writer.
const EXPORT_CHUNK_ROWS: usize = 1_000;
/// Rows between `gridl-export-progress` events.
const EXPORT_PROGRESS_ROWS: u64 = 10_000;
/// Rows between `gridl-import-progress` events.
const IMPORT_PROGRESS_ROWS: u64 = 5_000;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub connection_id: String,
    pub path: String,
    pub delimiter: String,
    pub has_header: bool,
    /// Already-quoted, qualified target table.
    pub table: String,
    /// Already-quoted target column names.
    pub columns: Vec<String>,
    /// Per target column, the CSV column index that fills it, or `None` to skip it.
    pub mapping: Vec<Option<usize>>,
    /// Cell text that means NULL. Empty cells are NULL too.
    #[serde(default)]
    pub null_token: Option<String>,
    #[serde(default)]
    pub authorized: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub rows: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct ImportProgress {
    rows: u64,
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
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
    let id = ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    guard(state, id.as_str(), &[request.sql.as_str()], request.authorized)?;
    let path = export_path(&request.path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if !state.register_cancel(&request.query_id, Arc::clone(&cancel)).map_err(fail)? {
        return Err(format!("query '{}' is already running", request.query_id));
    }
    let _guard = CancelGuard { state, query_id: request.query_id.clone() };
    let query =
        QueryRequest::export(request.query_id, request.sql, EXPORT_CHUNK_ROWS, Arc::clone(&cancel))
            .map_err(fail)?;
    let file = File::create(&path).map_err(|err| format!("No se pudo crear el archivo: {err}"))?;
    let out = BufWriter::with_capacity(1024 * 1024, Counting { inner: file, bytes: 0 });
    let mut sink = FileSink {
        writer: ExportWriter::new(out, request.format, engine, &request.table),
        progress,
        next_progress: EXPORT_PROGRESS_ROWS,
        cancel,
        failed: None,
    };
    let outcome = state.driver(engine).query(&id, &query, &mut sink).await;
    let finished = match (outcome, sink.failed.take()) {
        (_, Some(err)) => Err(format!("No se pudo escribir el archivo: {err}")),
        (Err(err), None) => Err(fail(err)),
        (Ok(result), None) if result.cancelled => Err("Exportación cancelada.".to_owned()),
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
            Err(format!("No se pudo escribir el archivo: {err}"))
        }
    }
}

/// The first rows of a CSV file. Guesses the delimiter among `, ; \t |` when none is given.
#[tauri::command]
pub async fn preview_csv(path: String, delimiter: Option<String>) -> Result<CsvPreview, String> {
    tokio::task::spawn_blocking(move || {
        gridl_core::preview_csv(&PathBuf::from(path), delimiter.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(fail)
}

/// Inserts the rows of a CSV file in one transaction. Nothing is kept if any row fails.
#[tauri::command]
pub async fn import_csv(
    window: Window,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportResult, String> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let progress = move |rows: u64| {
        emit_to_window(&app, &label, "gridl-import-progress", ImportProgress { rows });
    };
    run_import(&state, request, &progress).await
}

pub(crate) async fn run_import(
    state: &AppState,
    request: ImportRequest,
    report: &(dyn Fn(u64) + Send + Sync),
) -> Result<ImportResult, String> {
    let started = Instant::now();
    let id = ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    let targets: Vec<&str> = request
        .columns
        .iter()
        .zip(&request.mapping)
        .filter(|(_, source)| source.is_some())
        .map(|(column, _)| column.as_str())
        .collect();
    let shape = format!("INSERT INTO {} ({}) VALUES (NULL)", request.table, targets.join(", "));
    guard(state, id.as_str(), &[shape.as_str()], request.authorized)?;
    let plan = ImportPlan {
        engine,
        delimiter: gridl_core::parse_delimiter(&request.delimiter).map_err(fail)?,
        has_header: request.has_header,
        table: request.table,
        columns: request.columns,
        mapping: request.mapping,
        null_token: request.null_token,
    };
    let path = PathBuf::from(request.path);
    let batch = tokio::task::spawn_blocking(move || gridl_core::build_import(&path, &plan))
        .await
        .map_err(|err| err.to_string())?
        .map_err(fail)?;

    let mut cumulative = Vec::with_capacity(batch.spans.len());
    let mut total = 0;
    for (_, _, rows) in &batch.spans {
        total += rows;
        cumulative.push(total);
    }
    let spans = batch.spans;
    let rows = batch.rows;
    let request = BatchRequest::bulk(batch.statements).map_err(fail)?;
    let done = AtomicUsize::new(0);
    let reported = AtomicU64::new(0);
    let progress = |count: usize| {
        done.store(count, Ordering::SeqCst);
        let rows = cumulative.get(count.wrapping_sub(1)).copied().unwrap_or(0);
        let last = reported.load(Ordering::SeqCst);
        if rows - last >= IMPORT_PROGRESS_ROWS || count == cumulative.len() {
            reported.store(rows, Ordering::SeqCst);
            report(rows);
        }
    };
    let outcome = state.driver(engine).execute_batch_observed(&id, &request, &progress).await;
    match outcome {
        Ok(_) => Ok(ImportResult { rows, duration_ms: elapsed_ms(started) }),
        Err(err) => Err(import_error(&err, spans.get(done.load(Ordering::SeqCst)))),
    }
}

/// Names the CSV lines of the statement that failed. The engine's message
/// usually quotes the bad value.
fn import_error(err: &CoreError, span: Option<&(u64, u64, u64)>) -> String {
    let message = err.to_string();
    let detail = message.strip_prefix("database: ").unwrap_or(&message);
    let detail = match detail.strip_prefix("sentencia ").and_then(|rest| rest.split_once(": ")) {
        Some((_, rest)) => rest,
        None => detail,
    };
    match span {
        Some((first, last, _)) if first == last => {
            format!("Línea {first}: {detail}. No se importó ninguna fila.")
        }
        Some((first, last, _)) => {
            format!("Error en una fila de las líneas {first} a {last}: {detail}. No se importó ninguna fila.")
        }
        None => format!("{detail}. No se importó ninguna fila."),
    }
}

#[cfg(test)]
mod tests {
    use gridl_core::CoreError;

    use super::import_error;

    #[test]
    fn import_errors_name_the_csv_lines() {
        let err =
            CoreError::Database("sentencia 2: invalid input syntax for type integer: \"x\"".into());
        assert_eq!(
            import_error(&err, Some(&(502, 1001, 500))),
            "Error en una fila de las líneas 502 a 1001: invalid input syntax for type integer: \"x\". No se importó ninguna fila."
        );
        assert!(import_error(&err, Some(&(7, 7, 1))).starts_with("Línea 7: invalid input"));
    }
}

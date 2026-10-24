//! CSV import into a table: one transaction, so a bad row leaves the table as it was.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use gridl_core::{tr, BatchRequest, CoreError, CsvPreview, ImportPlan};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, Window};

use crate::commands::guard::guard;
use crate::commands::{elapsed_ms, fail};
use crate::state::AppState;
use crate::windows::emit_to_window;

/// Rows between `gridl-import-progress` events.
const IMPORT_PROGRESS_ROWS: u64 = 5_000;

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
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
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
        engine: driver.engine(),
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
    let outcome = driver.execute_batch_observed(&id, &request, &progress).await;
    match outcome {
        Ok(_) => Ok(ImportResult { rows, duration_ms: elapsed_ms(started) }),
        Err(err) => Err(import_error(&err, spans.get(done.load(Ordering::SeqCst)))),
    }
}

/// Names the CSV lines of the statement that failed. The engine's message
/// usually quotes the bad value.
fn import_error(err: &CoreError, span: Option<&(u64, u64, u64)>) -> String {
    let message = err.to_string();
    let detail = match err {
        CoreError::Statement { message, .. } => message.as_str(),
        _ => message.strip_prefix("database: ").unwrap_or(&message),
    };
    match span {
        Some((first, last, _)) if first == last => tr!(
            "Line {first}: {detail}. No rows were imported.",
            "Línea {first}: {detail}. No se importó ninguna fila."
        ),
        Some((first, last, _)) => tr!(
            "Error in a row on lines {first} to {last}: {detail}. No rows were imported.",
            "Error en una fila de las líneas {first} a {last}: {detail}. No se importó ninguna fila."
        ),
        None => tr!("{detail}. No rows were imported.", "{detail}. No se importó ninguna fila."),
    }
}

#[cfg(test)]
mod tests {
    use gridl_core::{with_locale, CoreError, Locale};

    use super::import_error;

    #[test]
    fn import_errors_name_the_csv_lines() {
        let err = CoreError::Statement {
            number: 2,
            message: "invalid input syntax for type integer: \"x\"".into(),
        };
        assert_eq!(
            with_locale(Locale::Es, || import_error(&err, Some(&(502, 1001, 500)))),
            "Error en una fila de las líneas 502 a 1001: invalid input syntax for type integer: \"x\". No se importó ninguna fila."
        );
        assert_eq!(
            with_locale(Locale::En, || import_error(&err, Some(&(502, 1001, 500)))),
            "Error in a row on lines 502 to 1001: invalid input syntax for type integer: \"x\". No rows were imported."
        );
        let single = with_locale(Locale::Es, || import_error(&err, Some(&(7, 7, 1))));
        assert!(single.starts_with("Línea 7: invalid input"), "{single}");
        let other = CoreError::Database("deadlock detected".into());
        assert_eq!(
            with_locale(Locale::En, || import_error(&other, None)),
            "deadlock detected. No rows were imported."
        );
    }
}

//! The schema of an open connection: the whole catalog, or one table again after a change.

use gridl_core::{EngineSpec, ForeignKey, RelationRef, SqlCheck, TableSchema};
use tauri::State;

use super::fail;
use crate::state::AppState;

/// The engines this build supports, as the frontend describes them.
#[tauri::command]
pub fn list_engines() -> Vec<EngineSpec> {
    gridl_core::builtin_specs()
}

#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<TableSchema>, String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    driver.introspect(&id).await.map_err(fail)
}

/// Reads one relation's columns again, after a change to its structure, so
/// the rest of the catalog is not read for nothing.
#[tauri::command]
pub async fn describe_relation(
    state: State<'_, AppState>,
    connection_id: String,
    relation: RelationRef,
) -> Result<TableSchema, String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    driver.describe_relation(&id, &relation).await.map_err(fail)
}

/// The indexes and triggers of one table, read again with it after a change.
#[tauri::command]
pub async fn table_objects(
    state: State<'_, AppState>,
    connection_id: String,
    relation: RelationRef,
) -> Result<Vec<TableSchema>, String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    driver.table_objects(&id, &relation).await.map_err(fail)
}

#[tauri::command]
pub async fn foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<ForeignKey>, String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    driver.foreign_keys(&id).await.map_err(fail)
}

/// Parses one statement without running it, for inline diagnostics in the editor.
#[tauri::command]
pub async fn check_sql(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<SqlCheck, String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    if sql.trim().is_empty() || sql.len() > gridl_core::MAX_SQL_BYTES {
        return Ok(SqlCheck::unknown());
    }
    driver.check(&id, &sql).await.map_err(fail)
}

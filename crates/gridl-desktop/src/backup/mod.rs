//! Backups and restores of an open session. Each engine's driver knows its
//! own tools; this module checks the paths, keeps a failed backup from
//! replacing a good file, asks the safety policy, and finds the password.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Instant;

use gridl_core::{tr, SecretString, ToolAccess};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::guard::guard_restore;
use crate::commands::session::typed_or_saved;
use crate::commands::{elapsed_ms, fail};
use crate::state::{AppState, Session};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    pub connection_id: String,
    pub path: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub connection_id: String,
    pub path: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub authorized: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub duration_ms: u64,
}

/// Writes a full backup of the session's database to `path`.
#[tauri::command]
pub async fn backup_database(
    state: State<'_, AppState>,
    request: BackupRequest,
) -> Result<BackupResult, String> {
    run_backup(&state, request).await
}

pub(crate) async fn run_backup(
    state: &AppState,
    request: BackupRequest,
) -> Result<BackupResult, String> {
    let started = Instant::now();
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
    let session = state.session(id.as_str()).map_err(fail)?;
    let path = PathBuf::from(&request.path);
    if path.is_dir() {
        return Err(tr!("the path is a folder", "la ruta es una carpeta"));
    }
    if !path.parent().is_none_or(|parent| parent.as_os_str().is_empty() || parent.is_dir()) {
        return Err(tr!("the destination folder doesn't exist", "la carpeta de destino no existe"));
    }
    // Write next to the target and rename at the end, so a failed backup
    // leaves an existing file alone.
    let mut partial = OsString::from(path.as_os_str());
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let _ = std::fs::remove_file(&partial);
    let password = password(state, request.password, &session).await?;
    let access = access(&session, password.as_ref());
    let saved = driver.backup(&id, &access, &partial).await.map_err(fail).and_then(|()| {
        std::fs::rename(&partial, &path).map_err(|err| {
            tr!("Couldn't save the backup: {err}", "No se pudo guardar el respaldo: {err}")
        })
    });
    if let Err(err) = saved {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }
    let bytes = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(BackupResult { path: request.path, bytes, duration_ms: elapsed_ms(started) })
}

/// Runs a backup file against the session's database, after the safety
/// policy allows it: restoring rewrites structure and data.
#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    request: RestoreRequest,
) -> Result<RestoreResult, String> {
    run_restore(&state, request).await
}

pub(crate) async fn run_restore(
    state: &AppState,
    request: RestoreRequest,
) -> Result<RestoreResult, String> {
    let started = Instant::now();
    let (id, driver) = state.open_session(request.connection_id).map_err(fail)?;
    let session = state.session(id.as_str()).map_err(fail)?;
    if session.config.read_only {
        return Err(tr!("The connection is read-only.", "La conexión es de solo lectura."));
    }
    let path = PathBuf::from(&request.path);
    if !path.is_file() {
        return Err(tr!("The backup file doesn't exist.", "El archivo de respaldo no existe."));
    }
    let description = format!("-- restaurar {}", path.display());
    guard_restore(state, id.as_str(), description, request.authorized)?;
    let password = password(state, request.password, &session).await?;
    driver.restore(&id, &access(&session, password.as_ref()), &path).await.map_err(fail)?;
    Ok(RestoreResult { duration_ms: elapsed_ms(started) })
}

/// What the driver's tools need to reach the session: its config, and the
/// local end of its SSH tunnel when it has one.
fn access<'a>(session: &'a Session, password: Option<&'a SecretString>) -> ToolAccess<'a> {
    ToolAccess { config: &session.config, endpoint: session.endpoint.clone(), password }
}

/// The password typed in the dialog, else the one saved in the keyring.
async fn password(
    state: &AppState,
    typed: Option<String>,
    session: &Session,
) -> Result<Option<SecretString>, String> {
    typed_or_saved(state, typed, session.config.credential_account.as_deref()).await.map_err(fail)
}

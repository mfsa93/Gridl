//! Saved connections and groups in `connections.json`, and their secrets in the OS keychain.

use std::path::PathBuf;
use std::sync::Arc;

use gridl_core::{
    add_group, load_catalog, remove_group, store_catalog, upsert_profile, ConnectionCatalog,
    CoreError, SecretString,
};
use tauri::{AppHandle, Manager, State};

use super::fail;
use super::session::ConnectRequest;
use crate::state::AppState;

#[tauri::command]
pub async fn list_profiles(app: AppHandle) -> Result<ConnectionCatalog, String> {
    let path = profiles_path(&app).map_err(fail)?;
    load_catalog(&path).map_err(fail)
}

#[tauri::command]
pub async fn save_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<ConnectionCatalog, String> {
    persist_connection(&app, &state, request).await.map_err(fail)
}

#[tauri::command]
pub async fn create_group(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<ConnectionCatalog, String> {
    with_catalog(&app, &state, move |path| add_group(&path, &name)).await.map_err(fail)
}

#[tauri::command]
pub async fn delete_group(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<ConnectionCatalog, String> {
    with_catalog(&app, &state, move |path| remove_group(&path, &name)).await.map_err(fail)
}

/// Removes a saved connection and the passwords it kept in the keychain.
#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<ConnectionCatalog, String> {
    let (accounts, catalog) = with_catalog(&app, &state, move |path| {
        let mut catalog = load_catalog(&path)?;
        let accounts: Vec<String> = catalog
            .profiles
            .iter()
            .filter(|profile| profile.id == connection_id)
            .flat_map(|profile| {
                [profile.credential_account.clone(), profile.ssh.credential_account.clone()]
            })
            .flatten()
            .collect();
        catalog.profiles.retain(|profile| profile.id != connection_id);
        store_catalog(&path, &catalog)?;
        Ok((accounts, catalog))
    })
    .await
    .map_err(fail)?;
    for account in accounts {
        state.vault.delete_async(&account).await.map_err(fail)?;
    }
    Ok(catalog)
}

/// Saves the connection of `request`, and its passwords when the user asked to remember them.
pub(crate) async fn persist_connection(
    app: &AppHandle,
    state: &AppState,
    mut request: ConnectRequest,
) -> Result<ConnectionCatalog, CoreError> {
    request.config = request.config.prepare()?;
    let password = typed_secret(request.password.take());
    let ssh_secret = typed_secret(request.ssh_secret.take());
    remember_secrets(state, &mut request, password.as_ref(), ssh_secret.as_ref()).await?;
    let config = request.config;
    with_catalog(app, state, move |path| upsert_profile(&path, config)).await
}

/// Stores the passwords the user asked to remember and points the config at
/// their keychain accounts.
pub(crate) async fn remember_secrets(
    state: &AppState,
    request: &mut ConnectRequest,
    password: Option<&SecretString>,
    ssh_secret: Option<&SecretString>,
) -> Result<(), CoreError> {
    let id = request.config.id.clone();
    if let (true, Some(secret)) = (request.remember_password, password) {
        let account = format!("connection:{id}");
        state.vault.store_async(&account, secret).await?;
        request.config.credential_account = Some(account);
    }
    if let (true, Some(secret)) = (request.remember_ssh_secret, ssh_secret) {
        let account = format!("connection:{id}:ssh");
        state.vault.store_async(&account, secret).await?;
        request.config.ssh.credential_account = Some(account);
    }
    Ok(())
}

/// A secret the user typed, if they typed one.
pub(crate) fn typed_secret(value: Option<String>) -> Option<SecretString> {
    value.filter(|value| !value.trim().is_empty()).map(SecretString::new)
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, CoreError> {
    let directory =
        app.path().app_data_dir().map_err(|err| CoreError::Internal(err.to_string()))?;
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("connections.json"))
}

/// Runs `operation` on the connections file off the async runtime, one writer
/// at a time, so two windows saving at once cannot lose each other's change.
async fn with_catalog<T: Send + 'static>(
    app: &AppHandle,
    state: &AppState,
    operation: impl FnOnce(PathBuf) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let path = profiles_path(app)?;
    let lock = Arc::clone(&state.profile_lock);
    tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| CoreError::LockPoisoned)?;
        operation(path)
    })
    .await
    .map_err(|err| CoreError::Internal(err.to_string()))?
}

//! Opening, testing and closing connections: secrets, the SSH tunnel and the
//! window that owns each session.

use std::time::Instant;

use gridl_core::{ConnectionConfig, ConnectionId, CoreError, SecretString, TableSchema};
use serde::Deserialize;
use tauri::{AppHandle, State, Window};

use super::profiles::{persist_connection, remember_secrets};
use super::{elapsed_ms, fail};
use crate::state::AppState;
use crate::tunnel::SshTunnel;
use gridl_core::tr;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config: ConnectionConfig,
    pub password: Option<String>,
    pub remember_password: bool,
    #[serde(default)]
    pub ssh_secret: Option<String>,
    #[serde(default)]
    pub remember_ssh_secret: bool,
    #[serde(default)]
    pub trust_ssh_host: bool,
    /// Return as soon as the session is open; the UI reads the schema itself
    /// with `introspect`, so a large catalog does not hold the workspace back.
    #[serde(default)]
    pub defer_schema: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    pub config: ConnectionConfig,
    pub tables: Vec<TableSchema>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResponse {
    pub message: String,
    pub duration_ms: u64,
    pub host_fingerprint: Option<String>,
}

/// Tells the window which step a slow connect is on: "schema" once the server answered.
const CONNECT_PROGRESS: &str = "gridl-connect-progress";

/// Opens a session owned by the calling window. When another open window
/// already owns the connection, it focuses that window and fails with
/// `gridl-focused:<label>` instead.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<ConnectResponse, String> {
    let connection_id = request.config.id.clone();
    if let Some(owner) = state.owner(&connection_id) {
        if owner != window.label() && crate::windows::focus(&app, &owner) {
            return Err(format!("{}{owner}", crate::windows::FOCUSED_PREFIX));
        }
    }
    let response = open_connection(&app, &state, request, window.label()).await.map_err(fail)?;
    state.set_owner(&connection_id, window.label());
    Ok(response)
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<TestResponse, String> {
    probe_connection(&state, request).await.map_err(fail)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    let (id, driver) = state.open_session(connection_id).map_err(fail)?;
    driver.disconnect(&id).await.map_err(fail)?;
    state.forget(&id);
    state.clear_owner(id.as_str());
    Ok(())
}

/// Closes a session if it is open: driver, bookkeeping, and tunnel.
pub(crate) async fn close_session(state: &AppState, connection_id: &str) {
    let Ok(id) = ConnectionId::new(connection_id) else {
        return;
    };
    if let Ok(engine) = state.engine(id.as_str()) {
        let _ = state.driver(engine).disconnect(&id).await;
    }
    state.forget(&id);
}

async fn open_connection(
    app: &AppHandle,
    state: &AppState,
    mut request: ConnectRequest,
    window: &str,
) -> Result<ConnectResponse, CoreError> {
    request.config = request.config.prepare()?;
    let (password, ssh_secret) = secrets(state, &mut request).await?;
    remember_secrets(state, &mut request, password.as_ref(), ssh_secret.as_ref()).await?;
    let link = open_link(&request.config, ssh_secret.as_ref(), request.trust_ssh_host).await?;
    if let Some(fingerprint) = link.fingerprint.clone() {
        request.config.ssh.host_fingerprint = Some(fingerprint);
    }

    let driver = state.driver(request.config.engine);
    let id = request.config.connection_id()?;
    driver.connect(&request.config, password.as_ref(), link.endpoint.clone()).await?;
    if let Some(tunnel) = link.tunnel {
        state.insert_tunnel(id.as_str(), tunnel);
    }
    state.track(&id, request.config.clone(), link.endpoint)?;
    let opened = async {
        let tables = if request.defer_schema {
            Vec::new()
        } else {
            crate::windows::emit_to_window(app, window, CONNECT_PROGRESS, "schema");
            driver.introspect(&id).await?
        };
        // The secrets were stored above; the profile keeps only their accounts.
        let saved = ConnectRequest { password: None, ssh_secret: None, ..request.clone() };
        persist_connection(app, state, saved).await?;
        Ok(tables)
    };
    match opened.await {
        Ok(tables) => Ok(ConnectResponse { config: request.config, tables }),
        Err(err) => {
            close_session(state, id.as_str()).await;
            Err(err)
        }
    }
}

async fn probe_connection(
    state: &AppState,
    mut request: ConnectRequest,
) -> Result<TestResponse, CoreError> {
    request.config = request.config.prepare()?;
    let (password, ssh_secret) = secrets(state, &mut request).await?;
    let started = Instant::now();
    let link = open_link(&request.config, ssh_secret.as_ref(), request.trust_ssh_host).await?;
    let probed = state
        .driver(request.config.engine)
        .probe(&request.config, password.as_ref(), link.endpoint)
        .await;
    drop(link.tunnel);
    let version = probed?;
    let message = if link.fingerprint.is_some() {
        tr!("Connected through SSH · {version}", "Conexión correcta por túnel SSH · {version}")
    } else {
        tr!("Connected · {version}", "Conexión correcta · {version}")
    };
    Ok(TestResponse {
        message,
        duration_ms: elapsed_ms(started),
        host_fingerprint: link.fingerprint,
    })
}

/// The database password and the SSH secret: typed in the form, or else from the keychain.
async fn secrets(
    state: &AppState,
    request: &mut ConnectRequest,
) -> Result<(Option<SecretString>, Option<SecretString>), CoreError> {
    let password = typed_or_saved(
        state,
        request.password.take(),
        request.config.credential_account.as_deref(),
    )
    .await?;
    let ssh_secret = typed_or_saved(
        state,
        request.ssh_secret.take(),
        request.config.ssh.credential_account.as_deref(),
    )
    .await?;
    Ok((password, ssh_secret))
}

/// A secret typed in a form, else the one saved under `account` in the keychain.
pub(crate) async fn typed_or_saved(
    state: &AppState,
    typed: Option<String>,
    account: Option<&str>,
) -> Result<Option<SecretString>, CoreError> {
    if let Some(value) = typed.filter(|value| !value.is_empty()) {
        return Ok(Some(SecretString::new(value)));
    }
    match account {
        Some(account) => Ok(Some(state.vault.load_async(account).await?)),
        None => Ok(None),
    }
}

/// How the driver reaches the server: directly, or through an SSH tunnel's local end.
struct Link {
    tunnel: Option<SshTunnel>,
    endpoint: Option<(String, u16)>,
    fingerprint: Option<String>,
}

async fn open_link(
    config: &ConnectionConfig,
    ssh_secret: Option<&SecretString>,
    trust_ssh_host: bool,
) -> Result<Link, CoreError> {
    if !config.ssh.enabled {
        return Ok(Link { tunnel: None, endpoint: None, fingerprint: None });
    }
    let (target_host, target_port) = config.server();
    let opened =
        crate::tunnel::open(&config.ssh, &target_host, target_port, ssh_secret, trust_ssh_host)
            .await?;
    let endpoint = ("127.0.0.1".to_owned(), opened.tunnel.local_port());
    Ok(Link {
        tunnel: Some(opened.tunnel),
        endpoint: Some(endpoint),
        fingerprint: Some(opened.fingerprint),
    })
}

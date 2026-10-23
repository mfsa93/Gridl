use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use gridl_core::{
    add_group, load_catalog, remove_group, store_catalog, upsert_profile, BatchRequest,
    BatchResult, BatchStatement, ChunkSink, ConnectionCatalog, ConnectionConfig, CoreError,
    DatabaseEngine, QueryRequest, QueryResult, RowChunk, SecretString, SqlCheck, TableSchema,
    DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;
use gridl_core::ForeignKey;
use gridl_core::GuardMode;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub connection_id: String,
    pub query_id: String,
    pub sql: String,
    pub params: Vec<gridl_core::SqlValue>,
    pub chunk_rows: Option<usize>,
    /// The user confirmed a statement the safety policy asks about.
    #[serde(default)]
    pub authorized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteBatchRequest {
    pub connection_id: String,
    pub statements: Vec<BatchStatement>,
    #[serde(default)]
    pub authorized: bool,
}

/// Prefix of the error the UI turns into an authorization prompt or a block notice.
const GUARD_PREFIX: &str = "gridl-guard:";

/// Refuses SQL the connection's policy blocks, or that needs an authorization the request lacks.
fn guard(state: &AppState, id: &str, sql: &[&str], authorized: bool) -> Result<(), String> {
    let safety = state.safety(id).map_err(fail)?;
    let joined = sql.join(";\n");
    let verdict = gridl_core::evaluate(&safety, &joined);
    let refused = match verdict.mode {
        GuardMode::Allow => false,
        GuardMode::Confirm => !authorized,
        GuardMode::Block => true,
    };
    if !refused {
        return Ok(());
    }
    let payload = serde_json::json!({
        "mode": verdict.mode,
        "reason": verdict.reason,
        "dangerous": verdict.dangerous,
        "environment": safety.environment,
        "sql": joined,
    });
    Err(format!("{GUARD_PREFIX}{payload}"))
}

/// Extensions the export command may write. The path comes from a save dialog.
const EXPORT_EXTENSIONS: [&str; 5] = ["csv", "tsv", "json", "sql", "txt"];
/// Upper bound for one exported file.
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

struct ChannelSink(Channel<RowChunk>);

#[async_trait]
impl ChunkSink for ChannelSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.send(chunk).map_err(|err| CoreError::Delivery(err.to_string()))
    }
}

struct CancelGuard<'a> {
    state: &'a AppState,
    query_id: String,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_cancel(&self.query_id);
    }
}

fn fail(err: CoreError) -> String {
    err.to_string()
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, CoreError> {
    let directory =
        app.path().app_data_dir().map_err(|err| CoreError::Internal(err.to_string()))?;
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("connections.json"))
}

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
    mutate_catalog(&app, &state, move |path| add_group(&path, &name)).await.map_err(fail)
}

#[tauri::command]
pub async fn delete_group(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<ConnectionCatalog, String> {
    mutate_catalog(&app, &state, move |path| remove_group(&path, &name)).await.map_err(fail)
}

#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<ConnectionCatalog, String> {
    let path = profiles_path(&app).map_err(fail)?;
    let lock = Arc::clone(&state.profile_lock);
    let id = connection_id;
    let (accounts, catalog) = tokio::task::spawn_blocking(move || -> Result<_, CoreError> {
        let _guard = lock.lock().map_err(|_| CoreError::LockPoisoned)?;
        let mut catalog = load_catalog(&path)?;
        let profile = catalog.profiles.iter().find(|profile| profile.id == id);
        let mut accounts = Vec::new();
        if let Some(profile) = profile {
            if let Some(account) = profile.credential_account.clone() {
                accounts.push(account);
            }
            if let Some(account) = profile.ssh.credential_account.clone() {
                accounts.push(account);
            }
        }
        catalog.profiles.retain(|profile| profile.id != id);
        store_catalog(&path, &catalog)?;
        Ok((accounts, catalog))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(fail)?;
    for account in accounts {
        state.vault.delete_async(&account).await.map_err(fail)?;
    }
    Ok(catalog)
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<TestResponse, String> {
    probe_connection(&state, request).await.map_err(fail)
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<ConnectResponse, String> {
    open_connection(&app, &state, request).await.map_err(fail)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    state.driver(engine).disconnect(&id).await.map_err(fail)?;
    state.untrack(&id);
    state.drop_tunnel(id.as_str());
    Ok(())
}

#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<TableSchema>, String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    state.driver(engine).introspect(&id).await.map_err(fail)
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
    let id = gridl_core::ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    guard(&state, id.as_str(), &[request.sql.as_str()], request.authorized)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if !state.register_cancel(&request.query_id, Arc::clone(&cancel)).map_err(fail)? {
        return Err(format!("query '{}' is already running", request.query_id));
    }
    let _guard = CancelGuard { state: &state, query_id: request.query_id.clone() };
    let query = QueryRequest::new(
        request.query_id,
        request.sql,
        request.params,
        request.chunk_rows.unwrap_or(DEFAULT_CHUNK_ROWS),
        MAX_STREAM_ROWS,
        cancel,
    )
    .map_err(fail)?;
    let mut sink = ChannelSink(on_chunk);
    state.driver(engine).query(&id, &query, &mut sink).await.map_err(fail)
}

/// The UI reports whether it holds edits that closing the app would lose.
#[tauri::command]
pub fn set_unsaved(state: State<'_, AppState>, unsaved: bool) {
    state.unsaved.store(unsaved, std::sync::atomic::Ordering::Relaxed);
}

/// Quits after the user chose to discard pending edits.
#[tauri::command]
pub fn quit_discarding(app: AppHandle, state: State<'_, AppState>) {
    state.unsaved.store(false, std::sync::atomic::Ordering::Relaxed);
    app.exit(0);
}

#[tauri::command]
pub async fn foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<ForeignKey>, String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    state.driver(engine).foreign_keys(&id).await.map_err(fail)
}

/// Parses one statement without running it, for inline diagnostics in the editor.
#[tauri::command]
pub async fn check_sql(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<SqlCheck, String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    if sql.trim().is_empty() || sql.len() > gridl_core::MAX_SQL_BYTES {
        return Ok(SqlCheck::unknown());
    }
    state.driver(engine).check(&id, &sql).await.map_err(fail)
}

/// Applies statements in one transaction. On failure nothing is committed.
#[tauri::command]
pub async fn execute_batch(
    state: State<'_, AppState>,
    request: ExecuteBatchRequest,
) -> Result<BatchResult, String> {
    let id = gridl_core::ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    let sql: Vec<&str> =
        request.statements.iter().map(|statement| statement.sql.as_str()).collect();
    guard(&state, id.as_str(), &sql, request.authorized)?;
    let batch = BatchRequest::new(request.statements).map_err(fail)?;
    state.driver(engine).execute_batch(&id, &batch).await.map_err(fail)
}

/// Writes exported rows to a path the user picked in the save dialog.
#[tauri::command]
pub async fn write_export(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("extensión no permitida: .{extension}"));
    }
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("el archivo supera 512 MiB".into());
    }
    if path.is_dir() {
        return Err("la ruta es una carpeta".into());
    }
    tokio::task::spawn_blocking(move || std::fs::write(&path, contents.as_bytes()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

async fn open_connection(
    app: &AppHandle,
    state: &AppState,
    mut request: ConnectRequest,
) -> Result<ConnectResponse, CoreError> {
    request.config = request.config.prepare()?;
    let secret =
        take_or_load(state, request.password.take(), request.config.credential_account.as_deref())
            .await?;
    if request.remember_password {
        if let Some(secret) = secret.as_ref() {
            let account = format!("connection:{}", request.config.id);
            state.vault.store_async(&account, secret).await?;
            request.config.credential_account = Some(account);
        }
    }
    let ssh_secret = take_or_load(
        state,
        request.ssh_secret.take(),
        request.config.ssh.credential_account.as_deref(),
    )
    .await?;
    remember_ssh(state, &mut request, ssh_secret.as_ref()).await?;
    let link = open_link(&request.config, ssh_secret.as_ref(), request.trust_ssh_host).await?;
    if let Some(fingerprint) = link.fingerprint.clone() {
        request.config.ssh.host_fingerprint = Some(fingerprint);
    }

    let engine = request.config.engine;
    let driver = state.driver(engine);
    let id = request.config.connection_id()?;
    driver.connect(&request.config, secret.as_ref(), link.endpoint.clone()).await?;
    if let Some(tunnel) = link.tunnel {
        state.insert_tunnel(id.as_str(), tunnel);
    }
    state.track(&id, engine, request.config.safety.clone())?;
    let tables = match driver.introspect(&id).await {
        Ok(tables) => tables,
        Err(err) => {
            let _ = driver.disconnect(&id).await;
            state.untrack(&id);
            state.drop_tunnel(id.as_str());
            return Err(err);
        }
    };
    if let Err(err) = persist_connection(app, state, request.clone()).await {
        let _ = driver.disconnect(&id).await;
        state.untrack(&id);
        state.drop_tunnel(id.as_str());
        return Err(err);
    }
    Ok(ConnectResponse { config: request.config, tables })
}

async fn probe_connection(
    state: &AppState,
    mut request: ConnectRequest,
) -> Result<TestResponse, CoreError> {
    request.config = request.config.prepare()?;
    let secret =
        take_or_load(state, request.password.take(), request.config.credential_account.as_deref())
            .await?;
    let ssh_secret = take_or_load(
        state,
        request.ssh_secret.take(),
        request.config.ssh.credential_account.as_deref(),
    )
    .await?;
    let started = Instant::now();
    let link = open_link(&request.config, ssh_secret.as_ref(), request.trust_ssh_host).await?;
    let probed = state
        .driver(request.config.engine)
        .probe(&request.config, secret.as_ref(), link.endpoint)
        .await;
    drop(link.tunnel);
    let version = probed?;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let route = if link.fingerprint.is_some() { " por túnel SSH" } else { "" };
    Ok(TestResponse {
        message: format!("Conexión correcta{route} · {version}"),
        duration_ms,
        host_fingerprint: link.fingerprint,
    })
}

struct Link {
    tunnel: Option<crate::tunnel::SshTunnel>,
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
    let target_host = config.host.clone().unwrap_or_else(|| "localhost".into());
    let target_port = config.port.unwrap_or_else(|| default_port(config.engine));
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

fn default_port(engine: DatabaseEngine) -> u16 {
    match engine {
        DatabaseEngine::Postgres => 5432,
        DatabaseEngine::Mysql => 3306,
        DatabaseEngine::Sqlite => 0,
    }
}

async fn take_or_load(
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

async fn remember_ssh(
    state: &AppState,
    request: &mut ConnectRequest,
    secret: Option<&SecretString>,
) -> Result<(), CoreError> {
    if request.remember_ssh_secret {
        if let Some(secret) = secret {
            let account = format!("connection:{}:ssh", request.config.id);
            state.vault.store_async(&account, secret).await?;
            request.config.ssh.credential_account = Some(account);
        }
    }
    Ok(())
}

async fn persist_connection(
    app: &AppHandle,
    state: &AppState,
    mut request: ConnectRequest,
) -> Result<ConnectionCatalog, CoreError> {
    request.config = request.config.prepare()?;
    let secret =
        request.password.take().filter(|value| !value.trim().is_empty()).map(SecretString::new);
    if request.remember_password {
        if let Some(secret) = secret.as_ref() {
            let account = format!("connection:{}", request.config.id);
            state.vault.store_async(&account, secret).await?;
            request.config.credential_account = Some(account);
        }
    }
    let ssh_secret =
        request.ssh_secret.take().filter(|value| !value.trim().is_empty()).map(SecretString::new);
    remember_ssh(state, &mut request, ssh_secret.as_ref()).await?;
    let path = profiles_path(app)?;
    let lock = Arc::clone(&state.profile_lock);
    let config = request.config;
    tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| CoreError::LockPoisoned)?;
        upsert_profile(&path, config)
    })
    .await
    .map_err(|err| CoreError::Internal(err.to_string()))?
}

async fn mutate_catalog(
    app: &AppHandle,
    state: &AppState,
    operation: impl FnOnce(std::path::PathBuf) -> Result<ConnectionCatalog, CoreError> + Send + 'static,
) -> Result<ConnectionCatalog, CoreError> {
    let path = profiles_path(app)?;
    let lock = Arc::clone(&state.profile_lock);
    tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| CoreError::LockPoisoned)?;
        operation(path)
    })
    .await
    .map_err(|err| CoreError::Internal(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use gridl_core::{ConnectionId, DatabaseEngine, Environment, GuardMode, SafetySettings};

    use super::{guard, GUARD_PREFIX};
    use crate::state::AppState;

    fn session(state: &AppState, id: &str, writes: GuardMode, schema: GuardMode) {
        let safety = SafetySettings {
            environment: Environment::Staging,
            writes,
            schema,
            confirm_dangerous: true,
        };
        state
            .track(&ConnectionId::new(id).expect("id"), DatabaseEngine::Sqlite, safety)
            .expect("track");
    }

    #[test]
    fn guard_asks_blocks_and_lets_reads_through() {
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Confirm);
        session(&state, "prod", GuardMode::Block, GuardMode::Block);

        assert!(guard(&state, "stg", &["select * from t"], false).is_ok());
        let asked = guard(&state, "stg", &["update t set a = 1 where id = 2"], false)
            .expect_err("needs authorization");
        assert!(asked.starts_with(GUARD_PREFIX));
        assert!(asked.contains("\"mode\":\"confirm\""));
        assert!(guard(&state, "stg", &["update t set a = 1 where id = 2"], true).is_ok());

        let blocked = guard(&state, "prod", &["delete from t where id = 1"], true)
            .expect_err("blocked even when authorized");
        assert!(blocked.contains("\"mode\":\"block\""));
        assert!(guard(&state, "prod", &["select 1", "begin"], false).is_ok());
        let batch = guard(&state, "prod", &["select 1", "drop table t"], true).expect_err("batch");
        assert!(batch.contains("\"mode\":\"block\""));
    }
}

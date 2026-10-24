use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    add_group, load_catalog, remove_group, store_catalog, upsert_profile, BatchRequest,
    BatchResult, BatchStatement, ChunkSink, ConnectionCatalog, ConnectionConfig, CoreError,
    DatabaseEngine, QueryRequest, QueryResult, RowChunk, SecretString, SqlCheck, TableSchema,
    DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

use crate::state::AppState;
use gridl_core::tr;
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

/// Prefix of the error the UI turns into an authorization prompt or a block notice.
const GUARD_PREFIX: &str = "gridl-guard:";

/// Refuses SQL the connection's policy blocks, or that needs an authorization the request lacks.
pub(crate) fn guard(
    state: &AppState,
    id: &str,
    sql: &[&str],
    authorized: bool,
) -> Result<(), String> {
    let safety = state.safety(id).map_err(fail)?;
    let joined = sql.join(";\n");
    let verdict = gridl_core::evaluate(&safety, &joined);
    refuse(&safety, verdict, joined, authorized)
}

/// Like [`guard`] for restoring a backup, which rewrites structure and data.
pub(crate) fn guard_restore(
    state: &AppState,
    id: &str,
    description: String,
    authorized: bool,
) -> Result<(), String> {
    let safety = state.safety(id).map_err(fail)?;
    let verdict = gridl_core::evaluate_restore(&safety);
    refuse(&safety, verdict, description, authorized)
}

fn refuse(
    safety: &gridl_core::SafetySettings,
    verdict: gridl_core::Verdict,
    joined: String,
    authorized: bool,
) -> Result<(), String> {
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
pub(crate) const EXPORT_EXTENSIONS: [&str; 5] = ["csv", "tsv", "json", "sql", "txt"];
/// Upper bound for one exported file.
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

struct ChannelSink(Channel<RowChunk>);

#[async_trait]
impl ChunkSink for ChannelSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.send(chunk).map_err(|err| CoreError::Delivery(err.to_string()))
    }
}

/// Clears a query's cancel flag when the command returns.
pub(crate) struct CancelGuard<'a> {
    pub state: &'a AppState,
    pub query_id: String,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_cancel(&self.query_id);
    }
}

pub(crate) fn fail(err: CoreError) -> String {
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
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    state.driver(engine).disconnect(&id).await.map_err(fail)?;
    state.untrack(&id);
    state.drop_tunnel(id.as_str());
    state.clear_owner(id.as_str());
    Ok(())
}

/// Closes a session if it is open: driver, bookkeeping, and tunnel.
pub(crate) async fn close_session(state: &AppState, connection_id: &str) {
    let Ok(id) = gridl_core::ConnectionId::new(connection_id) else {
        return;
    };
    if let Ok(engine) = state.engine(id.as_str()) {
        let _ = state.driver(engine).disconnect(&id).await;
    }
    state.untrack(&id);
    state.drop_tunnel(id.as_str());
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
    let mut sink = ChannelSink(on_chunk);
    run_query(&state, request, &mut sink).await
}

pub(crate) async fn run_query(
    state: &AppState,
    request: ExecuteQueryRequest,
    sink: &mut dyn ChunkSink,
) -> Result<QueryResult, String> {
    let id = gridl_core::ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    guard(state, id.as_str(), &[request.sql.as_str()], request.authorized)?;
    let timeout = statement_timeout(state, id.as_str());
    let cancel = Arc::new(AtomicBool::new(false));
    if !state.register_cancel(&request.query_id, Arc::clone(&cancel)).map_err(fail)? {
        let query_id = &request.query_id;
        return Err(tr!(
            "the query '{query_id}' is already running",
            "la consulta '{query_id}' ya se está ejecutando"
        ));
    }
    let _guard = CancelGuard { state, query_id: request.query_id.clone() };
    let max_rows = request.max_rows.unwrap_or(MAX_STREAM_ROWS).clamp(1, MAX_STREAM_ROWS);
    let query = QueryRequest::new(
        request.query_id,
        request.sql,
        request.params,
        request.chunk_rows.unwrap_or(DEFAULT_CHUNK_ROWS),
        max_rows,
        Arc::clone(&cancel),
    )
    .map_err(fail)?;
    let query = if request.browse { query.browsing() } else { query };
    let timer = timeout.map(|seconds| Timer::start(seconds, Arc::clone(&cancel)));
    let outcome = state.driver(engine).query(&id, &query, sink).await;
    // Once the timer fires the result is partial at best, even when the
    // engine reports the interrupted statement as finished (MySQL `SLEEP`).
    if let Some(timer) = timer.filter(Timer::fired) {
        return Err(timeout_message(timer.seconds));
    }
    outcome.map_err(fail)
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

/// The UI reports whether the calling window holds edits that closing it would lose.
#[tauri::command]
pub fn set_unsaved(window: Window, state: State<'_, AppState>, unsaved: bool) {
    state.set_unsaved(window.label(), unsaved);
}

/// Quits after the user chose to discard pending edits.
#[tauri::command]
pub fn quit_discarding(app: AppHandle, state: State<'_, AppState>) {
    state.clear_unsaved();
    app.exit(0);
}

/// Closes the calling window after the user chose to discard its pending edits.
#[tauri::command]
pub fn close_discarding(window: Window, state: State<'_, AppState>) -> Result<(), String> {
    state.set_unsaved(window.label(), false);
    window.destroy().map_err(|err| err.to_string())
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
    run_batch(&state, request).await
}

pub(crate) async fn run_batch(
    state: &AppState,
    request: ExecuteBatchRequest,
) -> Result<BatchResult, String> {
    let id = gridl_core::ConnectionId::new(request.connection_id).map_err(fail)?;
    let engine = state.engine(id.as_str()).map_err(fail)?;
    let sql: Vec<&str> =
        request.statements.iter().map(|statement| statement.sql.as_str()).collect();
    guard(state, id.as_str(), &sql, request.authorized)?;
    let batch = BatchRequest::new(request.statements).map_err(fail)?;
    let work = state.driver(engine).execute_batch(&id, &batch);
    match statement_timeout(state, id.as_str()) {
        // Dropping the unfinished batch drops its transaction, which rolls back.
        Some(seconds) => tokio::time::timeout(Duration::from_secs(u64::from(seconds)), work)
            .await
            .map_err(|_| timeout_message(seconds))?
            .map_err(fail),
        None => work.await.map_err(fail),
    }
}

/// Writes exported rows to a path the user picked in the save dialog.
#[tauri::command]
pub async fn write_export(path: String, contents: String) -> Result<(), String> {
    let path = export_path(&path)?;
    if contents.len() > MAX_EXPORT_BYTES {
        return Err(tr!("the file is larger than 512 MiB", "el archivo supera 512 MiB"));
    }
    tokio::task::spawn_blocking(move || std::fs::write(&path, contents.as_bytes()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Checks a save-dialog path for an export: an allowed extension, not a folder.
pub(crate) fn export_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(tr!(
            "extension not allowed: .{extension}",
            "extensión no permitida: .{extension}"
        ));
    }
    if path.is_dir() {
        return Err(tr!("the path is a folder", "la ruta es una carpeta"));
    }
    Ok(path)
}

/// Tells the window which step a slow connect is on: "schema" once the server answered.
const CONNECT_PROGRESS: &str = "gridl-connect-progress";

async fn open_connection(
    app: &AppHandle,
    state: &AppState,
    mut request: ConnectRequest,
    window: &str,
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
    state.track(&id, request.config.clone(), link.endpoint.clone())?;
    crate::windows::emit_to_window(app, window, CONNECT_PROGRESS, "schema");
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
    let message = if link.fingerprint.is_some() {
        tr!("Connected through SSH · {version}", "Conexión correcta por túnel SSH · {version}")
    } else {
        tr!("Connected · {version}", "Conexión correcta · {version}")
    };
    Ok(TestResponse { message, duration_ms, host_fingerprint: link.fingerprint })
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
    gridl_core::engine_spec(engine).connection.default_port.unwrap_or(0)
}

/// The engines this build supports, as the frontend describes them.
#[tauri::command]
pub fn list_engines() -> Vec<gridl_core::EngineSpec> {
    gridl_core::builtin_specs()
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
    use gridl_core::{
        ConnectionConfig, ConnectionId, DatabaseEngine, Environment, GuardMode, SafetySettings,
    };

    use super::{guard, guard_restore, timeout_message, GUARD_PREFIX};
    use crate::state::AppState;

    pub(crate) fn sqlite_config(
        id: &str,
        database: &str,
        safety: SafetySettings,
    ) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: id.into(),
            engine: DatabaseEngine::Sqlite,
            database: database.into(),
            host: None,
            port: None,
            username: None,
            credential_account: None,
            group: None,
            read_only: false,
            create_if_missing: true,
            tls: gridl_core::TlsSettings::default(),
            ssh: gridl_core::SshSettings::default(),
            safety,
        }
    }

    fn session(state: &AppState, id: &str, writes: GuardMode, schema: GuardMode) {
        let safety = SafetySettings {
            environment: Environment::Staging,
            writes,
            schema,
            confirm_dangerous: true,
            timeout_secs: None,
        };
        state
            .track(&ConnectionId::new(id).expect("id"), sqlite_config(id, "x.db", safety), None)
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

    #[test]
    fn messages_follow_the_language() {
        use gridl_core::{with_locale, Locale};

        assert_eq!(
            with_locale(Locale::En, || timeout_message(30)),
            "The query exceeded the 30 s limit and was cancelled."
        );
        assert_eq!(
            with_locale(Locale::Es, || timeout_message(30)),
            "La consulta superó el tiempo límite de 30 s y se canceló."
        );
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Confirm);
        let refusal = |locale| {
            with_locale(locale, || guard(&state, "stg", &["insert into t values (1)"], false))
                .expect_err("asks")
        };
        // The payload keeps its shape; only the reason is translated.
        let english = refusal(Locale::En);
        let spanish = refusal(Locale::Es);
        assert!(english.starts_with(GUARD_PREFIX) && spanish.starts_with(GUARD_PREFIX));
        assert!(english.contains(r#""reason":"modifies data""#), "{english}");
        assert!(spanish.contains(r#""reason":"modifica datos""#), "{spanish}");
    }

    #[test]
    fn import_and_restore_go_through_the_guard() {
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Allow);
        session(&state, "open", GuardMode::Allow, GuardMode::Allow);
        session(&state, "ro", GuardMode::Block, GuardMode::Allow);

        let import = "INSERT INTO \"t\" (\"a\") VALUES (NULL)";
        assert!(guard(&state, "stg", &[import], false).is_err());
        assert!(guard(&state, "stg", &[import], true).is_ok());
        assert!(guard(&state, "open", &[import], false).is_ok());
        assert!(guard(&state, "ro", &[import], true).is_err());

        let asked = guard_restore(&state, "open", "-- restaurar x".into(), false)
            .expect_err("restore always asks");
        assert!(asked.contains("\"dangerous\":true"));
        assert!(guard_restore(&state, "open", "-- restaurar x".into(), true).is_ok());
        let blocked =
            guard_restore(&state, "ro", "-- restaurar x".into(), true).expect_err("block");
        assert!(blocked.contains("\"mode\":\"block\""));
    }
}

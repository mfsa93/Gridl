//! Backups with the engine's own tools (`pg_dump`, `mysqldump`, `VACUUM INTO`)
//! and restores with `psql` or `mysql`. Passwords go through the environment,
//! never the command line.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use gridl_core::{
    ChunkSink, ConnectionConfig, ConnectionId, CoreError, DatabaseEngine, QueryRequest, RowChunk,
    SecretString, TlsMode, DEFAULT_CHUNK_ROWS,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use gridl_core::tr;

use crate::commands::{fail, guard_restore};
use crate::state::{AppState, Session};

/// Folders searched after `PATH`. An app opened from Finder gets a short `PATH`.
const TOOL_DIRS: [&str; 5] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/usr/local/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
];

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

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
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
    let id = ConnectionId::new(request.connection_id).map_err(fail)?;
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
    let outcome = match session.config.engine {
        DatabaseEngine::Sqlite => vacuum_into(state, &id, &partial).await,
        DatabaseEngine::Postgres => {
            let password = password(state, request.password, &session.config).await?;
            let target = Target::of(&session);
            let mut args = vec![
                "--no-owner".to_owned(),
                "--no-privileges".to_owned(),
                // Drop objects before recreating them, so restoring over the same database works.
                "--clean".to_owned(),
                "--if-exists".to_owned(),
                format!("--file={}", partial.display()),
            ];
            args.extend(target.pg_args());
            run_tool("pg_dump", &args, pg_env(&session.config, password.as_ref()), None).await
        }
        DatabaseEngine::Mysql => {
            let password = password(state, request.password, &session.config).await?;
            let target = Target::of(&session);
            let mut args = vec![
                "--single-transaction".to_owned(),
                "--routines".to_owned(),
                "--triggers".to_owned(),
                // Dumping tablespaces needs the PROCESS privilege, which most users lack.
                "--no-tablespaces".to_owned(),
                format!("--result-file={}", partial.display()),
            ];
            args.extend(target.mysql_args(&session.config));
            run_tool("mysqldump", &args, mysql_env(password.as_ref()), None).await
        }
    };
    let renamed = outcome.and_then(|()| {
        std::fs::rename(&partial, &path).map_err(|err| {
            tr!("Couldn't save the backup: {err}", "No se pudo guardar el respaldo: {err}")
        })
    });
    if let Err(err) = renamed {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }
    let bytes = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(BackupResult { path: request.path, bytes, duration_ms: elapsed_ms(started) })
}

/// Runs a backup file against the session's database. PostgreSQL restores in
/// one transaction and stops at the first error.
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
    let id = ConnectionId::new(request.connection_id).map_err(fail)?;
    let session = state.session(id.as_str()).map_err(fail)?;
    if session.config.engine == DatabaseEngine::Sqlite {
        return Err(tr!(
            "To restore SQLite, open the backup file as a connection.",
            "Para restaurar un SQLite, abre el archivo de respaldo como conexión."
        ));
    }
    if session.config.read_only {
        return Err(tr!("The connection is read-only.", "La conexión es de solo lectura."));
    }
    let path = PathBuf::from(&request.path);
    if !path.is_file() {
        return Err(tr!("The backup file doesn't exist.", "El archivo de respaldo no existe."));
    }
    guard_restore(
        state,
        id.as_str(),
        format!("-- restaurar {}", path.display()),
        request.authorized,
    )?;
    let password = password(state, request.password, &session.config).await?;
    let target = Target::of(&session);
    match session.config.engine {
        DatabaseEngine::Postgres => {
            let mut args = vec![
                "--no-psqlrc".to_owned(),
                "--quiet".to_owned(),
                "-v".to_owned(),
                "ON_ERROR_STOP=1".to_owned(),
                "--single-transaction".to_owned(),
                format!("--file={}", path.display()),
            ];
            args.extend(target.pg_args());
            run_tool("psql", &args, pg_env(&session.config, password.as_ref()), None).await?;
        }
        DatabaseEngine::Mysql => {
            let input = std::fs::File::open(&path).map_err(|err| {
                tr!("Couldn't open the backup: {err}", "No se pudo abrir el respaldo: {err}")
            })?;
            let args = target.mysql_args(&session.config);
            run_tool("mysql", &args, mysql_env(password.as_ref()), Some(Stdio::from(input)))
                .await?;
        }
        DatabaseEngine::Sqlite => {}
    }
    Ok(RestoreResult { duration_ms: elapsed_ms(started) })
}

struct NullSink;

#[async_trait]
impl ChunkSink for NullSink {
    async fn on_chunk(&mut self, _chunk: RowChunk) -> Result<(), CoreError> {
        Ok(())
    }
}

/// SQLite copies itself with `VACUUM INTO`, consistent even while in use.
async fn vacuum_into(state: &AppState, id: &ConnectionId, path: &Path) -> Result<(), String> {
    let target = path
        .to_str()
        .ok_or_else(|| tr!("the path is not valid UTF-8", "la ruta no es UTF-8 válido"))?;
    let sql = format!("VACUUM INTO '{}'", target.replace('\'', "''"));
    let query_id = format!("backup-{}", std::process::id());
    let cancel = Arc::new(AtomicBool::new(false));
    let request = QueryRequest::new(query_id, sql, Vec::new(), DEFAULT_CHUNK_ROWS, 1, cancel)
        .map_err(fail)?;
    state.driver(DatabaseEngine::Sqlite).query(id, &request, &mut NullSink).await.map_err(fail)?;
    Ok(())
}

/// The password typed in the dialog, else the one saved in the keyring.
async fn password(
    state: &AppState,
    typed: Option<String>,
    config: &ConnectionConfig,
) -> Result<Option<SecretString>, String> {
    if let Some(value) = typed.filter(|value| !value.is_empty()) {
        return Ok(Some(SecretString::new(value)));
    }
    match config.credential_account.as_deref() {
        Some(account) => state.vault.load_async(account).await.map(Some).map_err(fail),
        None => Ok(None),
    }
}

/// Where the external tool connects: the SSH tunnel's local end when there is one.
struct Target {
    host: String,
    port: u16,
    user: Option<String>,
    database: String,
}

impl Target {
    fn of(session: &Session) -> Self {
        let config = &session.config;
        let (host, port) = match &session.endpoint {
            Some((host, port)) => (host.clone(), *port),
            None => (
                config.host.clone().unwrap_or_else(|| "localhost".into()),
                config.port.unwrap_or(match config.engine {
                    DatabaseEngine::Mysql => 3306,
                    _ => 5432,
                }),
            ),
        };
        Self { host, port, user: config.username.clone(), database: config.database.clone() }
    }

    fn pg_args(&self) -> Vec<String> {
        let mut args = vec![format!("--host={}", self.host), format!("--port={}", self.port)];
        if let Some(user) = &self.user {
            args.push(format!("--username={user}"));
        }
        args.push("--no-password".into());
        args.push(format!("--dbname={}", self.database));
        args
    }

    fn mysql_args(&self, config: &ConnectionConfig) -> Vec<String> {
        let mut args = vec![
            format!("--host={}", self.host),
            format!("--port={}", self.port),
            "--protocol=TCP".to_owned(),
        ];
        if let Some(user) = &self.user {
            args.push(format!("--user={user}"));
        }
        let mode = match config.tls.mode {
            TlsMode::Prefer => None,
            TlsMode::Disable => Some("DISABLED"),
            TlsMode::Require => Some("REQUIRED"),
            TlsMode::VerifyCa => Some("VERIFY_CA"),
            TlsMode::VerifyFull => Some("VERIFY_IDENTITY"),
        };
        if let Some(mode) = mode {
            args.push(format!("--ssl-mode={mode}"));
        }
        if let Some(path) = &config.tls.root_cert {
            args.push(format!("--ssl-ca={path}"));
        }
        if let Some(path) = &config.tls.client_cert {
            args.push(format!("--ssl-cert={path}"));
        }
        if let Some(path) = &config.tls.client_key {
            args.push(format!("--ssl-key={path}"));
        }
        args.push(self.database.clone());
        args
    }
}

fn pg_env(config: &ConnectionConfig, password: Option<&SecretString>) -> Vec<(String, String)> {
    let mode = match config.tls.mode {
        TlsMode::Disable => "disable",
        TlsMode::Prefer => "prefer",
        TlsMode::Require => "require",
        TlsMode::VerifyCa => "verify-ca",
        TlsMode::VerifyFull => "verify-full",
    };
    let mut env = vec![
        ("PGSSLMODE".to_owned(), mode.to_owned()),
        ("PGCONNECT_TIMEOUT".to_owned(), "15".to_owned()),
    ];
    if let Some(path) = &config.tls.root_cert {
        env.push(("PGSSLROOTCERT".into(), path.clone()));
    }
    if let Some(path) = &config.tls.client_cert {
        env.push(("PGSSLCERT".into(), path.clone()));
    }
    if let Some(path) = &config.tls.client_key {
        env.push(("PGSSLKEY".into(), path.clone()));
    }
    if let Some(password) = password {
        env.push(("PGPASSWORD".into(), password.expose().to_owned()));
    }
    env
}

fn mysql_env(password: Option<&SecretString>) -> Vec<(String, String)> {
    password
        .map(|password| vec![("MYSQL_PWD".into(), password.expose().to_owned())])
        .unwrap_or_default()
}

/// Finds `name` on `PATH` or in [`TOOL_DIRS`].
fn find_tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(TOOL_DIRS.iter().map(PathBuf::from))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn install_hint(name: &str) -> &'static str {
    match name {
        "pg_dump" | "psql" => "brew install libpq",
        _ => "brew install mysql-client",
    }
}

/// Runs an external tool and returns its stderr when it fails.
async fn run_tool(
    name: &str,
    args: &[String],
    env: Vec<(String, String)>,
    stdin: Option<Stdio>,
) -> Result<(), String> {
    let binary = find_tool(name).ok_or_else(|| {
        let hint = install_hint(name);
        tr!(
            "Couldn't find {name}. Install it with: {hint}",
            "No encontré {name}. Instálalo con: {hint}"
        )
    })?;
    let output = tokio::process::Command::new(&binary)
        .args(args)
        .envs(env)
        .stdin(stdin.unwrap_or_else(Stdio::null))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|err| tr!("Couldn't run {name}: {err}", "No se pudo ejecutar {name}: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        let status = output.status;
        return Err(tr!("{name} ended with {status}", "{name} terminó con {status}"));
    }
    Err(stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(engine: DatabaseEngine) -> ConnectionConfig {
        ConnectionConfig {
            id: "c".into(),
            name: "c".into(),
            engine,
            database: "app".into(),
            host: Some("db.internal".into()),
            port: None,
            username: Some("ana".into()),
            credential_account: None,
            group: None,
            read_only: false,
            create_if_missing: false,
            tls: gridl_core::TlsSettings::default(),
            ssh: gridl_core::SshSettings::default(),
            safety: gridl_core::SafetySettings::default(),
        }
    }

    #[test]
    fn tools_reach_the_tunnel_and_keep_passwords_off_the_command_line() {
        let direct = Session { config: config(DatabaseEngine::Postgres), endpoint: None };
        let args = Target::of(&direct).pg_args();
        assert!(args.contains(&"--host=db.internal".to_owned()));
        assert!(args.contains(&"--port=5432".to_owned()));
        assert!(args.contains(&"--dbname=app".to_owned()));

        let tunneled = Session {
            config: config(DatabaseEngine::Mysql),
            endpoint: Some(("127.0.0.1".into(), 40123)),
        };
        let args = Target::of(&tunneled).mysql_args(&tunneled.config);
        assert_eq!(args[..3], ["--host=127.0.0.1", "--port=40123", "--protocol=TCP"]);
        assert_eq!(args.last().map(String::as_str), Some("app"));

        let secret = SecretString::new("s3cret".into());
        let env = pg_env(&direct.config, Some(&secret));
        assert!(env.contains(&("PGPASSWORD".into(), "s3cret".into())));
        assert!(env.contains(&("PGSSLMODE".into(), "prefer".into())));
        assert!(!args.iter().any(|arg| arg.contains("s3cret")));
        assert_eq!(mysql_env(Some(&secret)), vec![("MYSQL_PWD".to_owned(), "s3cret".to_owned())]);
    }

    #[tokio::test]
    async fn missing_tools_say_how_to_install_them() {
        // The language is process-wide and other tests run alongside, so the
        // message is checked for what it names, not for its wording.
        let err = run_tool("gridl-no-such-tool", &[], Vec::new(), None).await.expect_err("missing");
        assert!(err.contains("gridl-no-such-tool"), "{err}");
        assert!(err.ends_with("brew install mysql-client"), "{err}");
        assert_eq!(install_hint("pg_dump"), "brew install libpq");
        assert_eq!(install_hint("psql"), "brew install libpq");
    }
}

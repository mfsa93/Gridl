//! Command logic end to end: SQLite always, PostgreSQL and MySQL when
//! `GRIDL_TEST_PG` / `GRIDL_TEST_MYSQL` point at a server, for example
//! `postgres:gridl@127.0.0.1:35432/gridl` and `root:gridl@127.0.0.1:33306/gridl`
//! (backup and restore also need `GRIDL_TEST_BACKUP=1` and the client tools installed).
//!
//! - `sqlite`: export, import, backup and row limits on a SQLite file.
//! - `servers`: time limits, imports and backups against live servers.

mod servers;
mod sqlite;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError, DatabaseEngine,
    ExportFormat, RowChunk, SafetySettings, SecretString, SqlValue, TlsMode,
};

use crate::backup::{run_backup, run_restore, BackupRequest, RestoreRequest};
use crate::commands::query::{run_batch, run_query, ExecuteBatchRequest, ExecuteQueryRequest};
use crate::state::AppState;
use crate::transfer::export::{run_export, ExportRequest};
use crate::transfer::import::{run_import, ImportRequest};

pub(super) struct VecSink(Vec<RowChunk>);

#[async_trait]
impl ChunkSink for VecSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.push(chunk);
        Ok(())
    }
}

pub(super) fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("gridl-desktop-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("dir");
    let path = directory.join(name);
    let _ = std::fs::remove_file(&path);
    path
}

pub(super) fn base_config(id: &str, engine: DatabaseEngine, database: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: id.into(),
        engine,
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
        safety: SafetySettings::default(),
    }
}

pub(super) async fn open(
    state: &AppState,
    config: ConnectionConfig,
    password: Option<&str>,
) -> ConnectionId {
    let id = config.connection_id().expect("id");
    let secret = password.map(|value| SecretString::new(value.to_owned()));
    state.driver(config.engine).connect(&config, secret.as_ref(), None).await.expect("connect");
    state.track(&id, config, None).expect("track");
    id
}

pub(super) async fn sqlite(state: &AppState, id: &str) -> (ConnectionId, PathBuf) {
    let path = scratch(&format!("{id}.db"));
    let config = base_config(id, DatabaseEngine::Sqlite, path.to_str().expect("utf8"));
    (open(state, config, None).await, path)
}

pub(super) fn query(id: &ConnectionId, query_id: &str, sql: &str) -> ExecuteQueryRequest {
    ExecuteQueryRequest {
        connection_id: id.as_str().into(),
        query_id: query_id.into(),
        sql: sql.into(),
        params: Vec::new(),
        chunk_rows: None,
        max_rows: None,
        authorized: true,
        browse: false,
    }
}

pub(super) async fn scalar(state: &AppState, id: &ConnectionId, sql: &str) -> SqlValue {
    let mut sink = VecSink(Vec::new());
    run_query(state, query(id, "scalar", sql), &mut sink).await.expect("query");
    sink.0.iter().flat_map(|chunk| chunk.rows.iter()).next().expect("row")[0].clone()
}

pub(super) async fn batch(
    state: &AppState,
    id: &ConnectionId,
    statements: &[&str],
) -> Result<(), String> {
    let statements = statements
        .iter()
        .map(|sql| BatchStatement { sql: (*sql).into(), params: Vec::new() })
        .collect();
    let request =
        ExecuteBatchRequest { connection_id: id.as_str().into(), statements, authorized: true };
    run_batch(state, request).await.map(|_| ())
}

pub(super) fn export_request(
    id: &ConnectionId,
    format: ExportFormat,
    path: &Path,
    sql: &str,
) -> ExportRequest {
    ExportRequest {
        connection_id: id.as_str().into(),
        query_id: "export-1".into(),
        sql: sql.into(),
        format,
        path: path.to_str().expect("utf8").into(),
        table: "\"copia\"".into(),
        authorized: false,
    }
}

pub(super) struct Server {
    user: String,
    password: String,
    host: String,
    port: u16,
    database: String,
}

pub(super) fn server(variable: &str) -> Option<Server> {
    let raw = std::env::var(variable).ok()?;
    let (credentials, rest) = raw.split_once('@')?;
    let (user, password) = credentials.split_once(':')?;
    let (address, database) = rest.split_once('/')?;
    let (host, port) = address.split_once(':')?;
    Some(Server {
        user: user.into(),
        password: password.into(),
        host: host.into(),
        port: port.parse().ok()?,
        database: database.into(),
    })
}

pub(super) async fn open_server(
    state: &AppState,
    id: &str,
    engine: DatabaseEngine,
    server: &Server,
) -> ConnectionId {
    let mut config = base_config(id, engine, &server.database);
    config.host = Some(server.host.clone());
    config.port = Some(server.port);
    config.username = Some(server.user.clone());
    config.create_if_missing = false;
    config.tls.mode = TlsMode::Disable;
    config.safety.timeout_secs = Some(1);
    open(state, config, Some(&server.password)).await
}

pub(super) async fn assert_timeouts(state: &AppState, id: &ConnectionId, sleep: &str, table: &str) {
    let started = Instant::now();
    let mut sink = VecSink(Vec::new());
    let err = run_query(state, query(id, "slow", &format!("SELECT {sleep}")), &mut sink)
        .await
        .expect_err("timeout");
    assert_eq!(err, crate::commands::query::timeout_message(1));
    assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
    // The editor connection is still usable.
    assert_eq!(scalar(state, id, "SELECT 1").await, SqlValue::Int(1));

    batch(
        state,
        id,
        &[&format!("DROP TABLE IF EXISTS {table}"), &format!("CREATE TABLE {table} (a INT)")],
    )
    .await
    .expect("table");
    let started = Instant::now();
    let err =
        batch(state, id, &[&format!("INSERT INTO {table} VALUES (1)"), &format!("SELECT {sleep}")])
            .await
            .expect_err("batch timeout");
    assert_eq!(err, crate::commands::query::timeout_message(1));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(scalar(state, id, &format!("SELECT count(*) FROM {table}")).await, SqlValue::Int(0));
}

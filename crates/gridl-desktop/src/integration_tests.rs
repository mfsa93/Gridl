//! Command logic end to end: SQLite always, PostgreSQL and MySQL when
//! `GRIDL_TEST_PG` / `GRIDL_TEST_MYSQL` point at a server, for example
//! (backup and restore also need `GRIDL_TEST_BACKUP=1` and the client tools installed)
//! `postgres:gridl@127.0.0.1:35432/gridl` and `root:gridl@127.0.0.1:33306/gridl`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError, DatabaseEngine,
    ExportFormat, RowChunk, SafetySettings, SecretString, SqlValue, TlsMode,
};

use crate::backup::{run_backup, run_restore, BackupRequest, RestoreRequest};
use crate::commands::{run_batch, run_query, ExecuteBatchRequest, ExecuteQueryRequest};
use crate::state::AppState;
use crate::transfer::{run_export, run_import, ExportRequest, ImportRequest};

struct VecSink(Vec<RowChunk>);

#[async_trait]
impl ChunkSink for VecSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.push(chunk);
        Ok(())
    }
}

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("gridl-desktop-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("dir");
    let path = directory.join(name);
    let _ = std::fs::remove_file(&path);
    path
}

fn base_config(id: &str, engine: DatabaseEngine, database: &str) -> ConnectionConfig {
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

async fn open(state: &AppState, config: ConnectionConfig, password: Option<&str>) -> ConnectionId {
    let id = config.connection_id().expect("id");
    let secret = password.map(|value| SecretString::new(value.to_owned()));
    state.driver(config.engine).connect(&config, secret.as_ref(), None).await.expect("connect");
    state.track(&id, config, None).expect("track");
    id
}

async fn sqlite(state: &AppState, id: &str) -> (ConnectionId, PathBuf) {
    let path = scratch(&format!("{id}.db"));
    let config = base_config(id, DatabaseEngine::Sqlite, path.to_str().expect("utf8"));
    (open(state, config, None).await, path)
}

fn query(id: &ConnectionId, query_id: &str, sql: &str) -> ExecuteQueryRequest {
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

async fn scalar(state: &AppState, id: &ConnectionId, sql: &str) -> SqlValue {
    let mut sink = VecSink(Vec::new());
    run_query(state, query(id, "scalar", sql), &mut sink).await.expect("query");
    sink.0.iter().flat_map(|chunk| chunk.rows.iter()).next().expect("row")[0].clone()
}

async fn batch(state: &AppState, id: &ConnectionId, statements: &[&str]) -> Result<(), String> {
    let statements = statements
        .iter()
        .map(|sql| BatchStatement { sql: (*sql).into(), params: Vec::new() })
        .collect();
    let request =
        ExecuteBatchRequest { connection_id: id.as_str().into(), statements, authorized: true };
    run_batch(state, request).await.map(|_| ())
}

fn export_request(
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

#[tokio::test]
async fn sqlite_export_streams_every_row_to_the_file() {
    let state = AppState::new();
    let (id, _) = sqlite(&state, "export").await;
    batch(
        &state,
        &id,
        &[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag BOOLEAN)",
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000) \
             INSERT INTO t SELECT i, 'fila, ' || i, NULL FROM n",
        ],
    )
    .await
    .expect("seed");
    let sql = "SELECT id, name, flag FROM t ORDER BY id";

    let seen = Mutex::new(Vec::new());
    let progress = |rows: u64| seen.lock().expect("lock").push(rows);
    let csv = scratch("export.csv");
    let result = run_export(&state, export_request(&id, ExportFormat::Csv, &csv, sql), &progress)
        .await
        .expect("csv");
    assert_eq!(result.rows, 25_000);
    let text = std::fs::read_to_string(&csv).expect("read");
    assert_eq!(result.bytes, text.len() as u64);
    assert!(text.starts_with("\u{FEFF}id,name,flag\r\n1,\"fila, 1\",\r\n2,\"fila, 2\",\r\n"));
    assert_eq!(text.matches("\r\n").count(), 25_001);
    assert_eq!(*seen.lock().expect("lock"), vec![10_000, 20_000, 25_000]);

    let json = scratch("export.json");
    run_export(&state, export_request(&id, ExportFormat::Json, &json, sql), &|_| {})
        .await
        .expect("json");
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json).expect("read")).expect("parse");
    assert_eq!(parsed.as_array().map(Vec::len), Some(25_000));
    assert_eq!(parsed[0], serde_json::json!({ "id": 1, "name": "fila, 1", "flag": null }));

    let inserts = scratch("export.sql");
    run_export(&state, export_request(&id, ExportFormat::Sql, &inserts, sql), &|_| {})
        .await
        .expect("sql");
    let text = std::fs::read_to_string(&inserts).expect("read");
    assert!(text.starts_with(
        "INSERT INTO \"copia\" (\"id\", \"name\", \"flag\") VALUES (1, 'fila, 1', NULL);\n"
    ));
    assert_eq!(text.lines().count(), 25_000);

    let broken = scratch("broken.csv");
    let err = run_export(
        &state,
        export_request(&id, ExportFormat::Csv, &broken, "SELECT * FROM missing"),
        &|_| {},
    )
    .await
    .expect_err("bad sql");
    assert!(err.contains("missing"), "{err}");
    assert!(!broken.exists(), "the partial file is removed");

    let bad_extension = scratch("export.exe");
    assert!(run_export(
        &state,
        export_request(&id, ExportFormat::Csv, &bad_extension, sql),
        &|_| {}
    )
    .await
    .is_err());
}

fn import_request(id: &ConnectionId, path: &Path, mapping: Vec<Option<usize>>) -> ImportRequest {
    ImportRequest {
        connection_id: id.as_str().into(),
        path: path.to_str().expect("utf8").into(),
        delimiter: ";".into(),
        has_header: true,
        table: "\"people\"".into(),
        columns: vec!["\"id\"".into(), "\"name\"".into(), "\"note\"".into()],
        mapping,
        null_token: Some("\\N".into()),
        authorized: false,
    }
}

#[tokio::test]
async fn sqlite_import_is_all_or_nothing_and_names_the_line() {
    let state = AppState::new();
    let (id, _) = sqlite(&state, "import").await;
    batch(
        &state,
        &id,
        &["CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT DEFAULT 'x')"],
    )
    .await
    .expect("table");

    let mut text = String::from("\u{FEFF}name;id;extra\n");
    for index in 1..=1_200 {
        text.push_str(&format!("\"O'Neil; {index}\";{index};\\N\n"));
    }
    let csv = scratch("people.csv");
    std::fs::write(&csv, &text).expect("write");
    let seen = Mutex::new(Vec::new());
    let progress = |rows: u64| seen.lock().expect("lock").push(rows);
    let result =
        run_import(&state, import_request(&id, &csv, vec![Some(1), Some(0), None]), &progress)
            .await
            .expect("import");
    assert_eq!(result.rows, 1_200);
    assert_eq!(seen.lock().expect("lock").last(), Some(&1_200));
    assert_eq!(scalar(&state, &id, "SELECT count(*) FROM people").await, SqlValue::Int(1_200));
    assert_eq!(
        scalar(&state, &id, "SELECT name || '|' || note FROM people WHERE id = 7").await,
        SqlValue::Text("O'Neil; 7|x".into())
    );
    assert_eq!(
        scalar(&state, &id, "SELECT typeof(id) FROM people WHERE id = 7").await,
        SqlValue::Text("integer".into())
    );

    // Line 703 has an empty name, which is NULL and breaks NOT NULL.
    let mut bad = String::from("name;id\n");
    for index in 2_001..=2_900 {
        let name = if index == 2_702 { String::new() } else { format!("n{index}") };
        bad.push_str(&format!("{name};{index}\n"));
    }
    let bad_csv = scratch("bad.csv");
    std::fs::write(&bad_csv, &bad).expect("write");
    let err =
        run_import(&state, import_request(&id, &bad_csv, vec![Some(1), Some(0), None]), &|_| {})
            .await
            .expect_err("not null");
    assert!(err.contains("502") && err.contains("901"), "{err}");
    assert_eq!(scalar(&state, &id, "SELECT count(*) FROM people").await, SqlValue::Int(1_200));
}

#[tokio::test]
async fn sqlite_backup_uses_vacuum_into() {
    let state = AppState::new();
    let (id, _) = sqlite(&state, "backup").await;
    batch(&state, &id, &["CREATE TABLE t (a INTEGER)", "INSERT INTO t VALUES (1), (2), (3)"])
        .await
        .expect("seed");
    let target = scratch("backup-copy.db");
    std::fs::write(&target, b"old").expect("existing file");
    let request = BackupRequest {
        connection_id: id.as_str().into(),
        path: target.to_str().expect("utf8").into(),
        password: None,
    };
    let result = run_backup(&state, request).await.expect("backup");
    assert!(result.bytes > 3);

    let copy = base_config("copy", DatabaseEngine::Sqlite, target.to_str().expect("utf8"));
    let copy = open(&state, copy, None).await;
    assert_eq!(scalar(&state, &copy, "SELECT count(*) FROM t").await, SqlValue::Int(3));
}

#[tokio::test]
async fn max_rows_caps_the_result() {
    let state = AppState::new();
    let (id, _) = sqlite(&state, "cap").await;
    let mut request = query(
        &id,
        "cap",
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT i FROM n",
    );
    request.max_rows = Some(10);
    let mut sink = VecSink(Vec::new());
    let result = run_query(&state, request, &mut sink).await.expect("query");
    assert_eq!(result.row_count, 10);
    assert!(result.truncated);
}

struct Server {
    user: String,
    password: String,
    host: String,
    port: u16,
    database: String,
}

fn server(variable: &str) -> Option<Server> {
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

async fn open_server(
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

async fn assert_timeouts(state: &AppState, id: &ConnectionId, sleep: &str, table: &str) {
    let started = Instant::now();
    let mut sink = VecSink(Vec::new());
    let err = run_query(state, query(id, "slow", &format!("SELECT {sleep}")), &mut sink)
        .await
        .expect_err("timeout");
    assert_eq!(err, crate::commands::timeout_message(1));
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
    assert_eq!(err, crate::commands::timeout_message(1));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(scalar(state, id, &format!("SELECT count(*) FROM {table}")).await, SqlValue::Int(0));
}

#[tokio::test]
async fn postgres_statement_timeout_cancels_queries_and_batches() {
    let Some(server) = server("GRIDL_TEST_PG") else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "pg-timeout", DatabaseEngine::Postgres, &server).await;
    assert_timeouts(&state, &id, "pg_sleep(5)", "gridl_timeout_probe").await;
}

#[tokio::test]
async fn mysql_statement_timeout_cancels_queries_and_batches() {
    let Some(server) = server("GRIDL_TEST_MYSQL") else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "my-timeout", DatabaseEngine::Mysql, &server).await;
    assert_timeouts(&state, &id, "SLEEP(5)", "gridl_timeout_probe").await;
}

#[tokio::test]
async fn postgres_import_coerces_text_literals() {
    let Some(server) = server("GRIDL_TEST_PG") else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "pg-import", DatabaseEngine::Postgres, &server).await;
    import_into_typed_table(&state, &id, "timestamp").await;
}

#[tokio::test]
async fn mysql_import_coerces_text_literals() {
    let Some(server) = server("GRIDL_TEST_MYSQL") else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "my-import", DatabaseEngine::Mysql, &server).await;
    import_into_typed_table(&state, &id, "datetime").await;
}

async fn import_into_typed_table(state: &AppState, id: &ConnectionId, stamp: &str) {
    batch(
        state,
        id,
        &[
            "DROP TABLE IF EXISTS gridl_import_probe",
            &format!(
                "CREATE TABLE gridl_import_probe (id INT PRIMARY KEY, amount NUMERIC(10,2), seen {stamp}, label VARCHAR(40))"
            ),
        ],
    )
    .await
    .expect("table");
    let csv = scratch(&format!("typed-{}.csv", id.as_str()));
    std::fs::write(
        &csv,
        "id,amount,seen,label\n1,12.50,2024-05-01 10:00:00,a\\b 'q'\n2,,2024-05-02 11:30:00,NULL\n",
    )
    .expect("write");
    let request = ImportRequest {
        connection_id: id.as_str().into(),
        path: csv.to_str().expect("utf8").into(),
        delimiter: ",".into(),
        has_header: true,
        table: "gridl_import_probe".into(),
        columns: vec!["id".into(), "amount".into(), "seen".into(), "label".into()],
        mapping: vec![Some(0), Some(1), Some(2), Some(3)],
        null_token: Some("NULL".into()),
        authorized: false,
    };
    let result = run_import(state, request, &|_| {}).await.expect("import");
    assert_eq!(result.rows, 2);
    assert_eq!(
        scalar(state, id, "SELECT label FROM gridl_import_probe WHERE id = 1").await,
        SqlValue::Text("a\\b 'q'".into())
    );
    assert_eq!(
        scalar(
            state,
            id,
            "SELECT count(*) FROM gridl_import_probe WHERE amount IS NULL AND label IS NULL"
        )
        .await,
        SqlValue::Int(1)
    );
}

/// Backs up a table, wipes it, restores the file, and checks the rows came back.
async fn backup_round_trip(state: &AppState, id: &ConnectionId, password: &str, extension: &str) {
    batch(
        state,
        id,
        &[
            "DROP TABLE IF EXISTS gridl_backup_probe",
            "CREATE TABLE gridl_backup_probe (id INT PRIMARY KEY, name VARCHAR(40))",
            "INSERT INTO gridl_backup_probe VALUES (1, 'uno'), (2, 'dos'), (3, 'tres')",
        ],
    )
    .await
    .expect("seed");
    let path = scratch(&format!("{}-backup.{extension}", id.as_str()));
    let done = run_backup(
        state,
        BackupRequest {
            connection_id: id.as_str().into(),
            path: path.to_string_lossy().into(),
            password: Some(password.into()),
        },
    )
    .await
    .expect("backup");
    assert!(done.bytes > 0);
    batch(state, id, &["DELETE FROM gridl_backup_probe WHERE id > 1"]).await.expect("wipe");
    assert_eq!(
        scalar(state, id, "SELECT count(*) FROM gridl_backup_probe").await,
        SqlValue::Int(1)
    );

    let unauthorized = RestoreRequest {
        connection_id: id.as_str().into(),
        path: path.to_string_lossy().into(),
        password: Some(password.into()),
        authorized: false,
    };
    // Restoring is destructive, so the guard asks first even on a local connection.
    assert!(run_restore(state, unauthorized)
        .await
        .expect_err("needs authorization")
        .starts_with("gridl-guard:"));
    run_restore(
        state,
        RestoreRequest {
            connection_id: id.as_str().into(),
            path: path.to_string_lossy().into(),
            password: Some(password.into()),
            authorized: true,
        },
    )
    .await
    .expect("restore over the same database");
    assert_eq!(
        scalar(state, id, "SELECT count(*) FROM gridl_backup_probe").await,
        SqlValue::Int(3)
    );
    let _ = std::fs::remove_file(path);
}

fn backup_enabled() -> bool {
    std::env::var("GRIDL_TEST_BACKUP").is_ok_and(|value| value == "1")
}

#[tokio::test]
async fn postgres_backup_and_restore_round_trip() {
    let Some(server) = server("GRIDL_TEST_PG").filter(|_| backup_enabled()) else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "pg-backup", DatabaseEngine::Postgres, &server).await;
    backup_round_trip(&state, &id, &server.password, "sql").await;
}

#[tokio::test]
async fn mysql_backup_and_restore_round_trip() {
    let Some(server) = server("GRIDL_TEST_MYSQL").filter(|_| backup_enabled()) else {
        return;
    };
    let state = AppState::new();
    let id = open_server(&state, "my-backup", DatabaseEngine::Mysql, &server).await;
    backup_round_trip(&state, &id, &server.password, "sql").await;
}

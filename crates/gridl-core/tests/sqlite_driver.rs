use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, BatchStatement, ChunkSink, ConnectionConfig, CoreError, DatabaseDriver,
    DatabaseEngine, QueryRequest, RowChunk, SqlValue, SqliteDriver, DEFAULT_CHUNK_ROWS,
    MAX_STREAM_ROWS,
};

struct VecSink(Vec<RowChunk>);

#[async_trait]
impl ChunkSink for VecSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.push(chunk);
        Ok(())
    }
}

struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        Self {
            path: std::env::temp_dir()
                .join(format!("gridl-{}-{nanos}-{n}.sqlite", std::process::id())),
        }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
    }
}

fn config(path: &std::path::Path) -> ConnectionConfig {
    ConnectionConfig {
        id: "test-conn".into(),
        name: "Test".into(),
        engine: DatabaseEngine::Sqlite,
        database: path.display().to_string(),
        host: None,
        port: None,
        username: None,
        credential_account: None,
        group: None,
        read_only: false,
        create_if_missing: true,
        tls: gridl_core::TlsSettings::default(),
        ssh: gridl_core::SshSettings::default(),
        safety: gridl_core::SafetySettings::default(),
    }
}

fn request(sql: &str, chunk_rows: usize, cancel: Arc<AtomicBool>) -> QueryRequest {
    QueryRequest::new("query-1", sql, Vec::new(), chunk_rows, MAX_STREAM_ROWS, cancel)
        .expect("request")
}

#[tokio::test]
async fn sqlite_streams_chunks_and_describes_schema() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    driver.connect(&connection, None, None).await.expect("connect");
    let id = connection.connection_id().expect("id");

    for sql in [
        "CREATE TABLE sample (
            id INTEGER PRIMARY KEY,
            name TEXT,
            score REAL,
            active BOOLEAN,
            payload BLOB
        )",
        "INSERT INTO sample (id, name, score, active, payload)
         VALUES (1, 'ada', 1.5, 1, X'6869')",
        "CREATE TABLE numbers (n INTEGER NOT NULL)",
        "INSERT INTO numbers (n)
         WITH RECURSIVE seq(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 250
         ) SELECT n FROM seq",
    ] {
        let mut sink = VecSink(Vec::new());
        driver
            .query(
                &id,
                &request(sql, DEFAULT_CHUNK_ROWS, Arc::new(AtomicBool::new(false))),
                &mut sink,
            )
            .await
            .expect(sql);
    }

    let tables = driver.introspect(&id).await.expect("introspect");
    let sample = tables.iter().find(|table| table.name == "sample").expect("sample");
    let id_column = sample.columns.iter().find(|column| column.name == "id").expect("id");
    assert!(id_column.primary_key);
    let name = sample.columns.iter().find(|column| column.name == "name").expect("name");
    assert!(name.nullable);

    let mut sink = VecSink(Vec::new());
    let result = driver
        .query(
            &id,
            &request(
                "SELECT id, name, score, active, payload FROM sample",
                10,
                Arc::new(AtomicBool::new(false)),
            ),
            &mut sink,
        )
        .await
        .expect("select sample");
    assert_eq!(result.row_count, 1);
    assert!(sink.0.last().is_some_and(|chunk| chunk.last));
    let row = &sink.0[0].rows[0];
    assert_eq!(row[0], SqlValue::Int(1));
    assert_eq!(row[1], SqlValue::Text("ada".into()));
    assert_eq!(row[2], SqlValue::Float(1.5));
    assert_eq!(row[4], SqlValue::Bytes(b"hi".to_vec()));

    let mut sink = VecSink(Vec::new());
    let streamed = driver
        .query(
            &id,
            &request("SELECT n FROM numbers ORDER BY n", 100, Arc::new(AtomicBool::new(false))),
            &mut sink,
        )
        .await
        .expect("stream");
    assert_eq!(streamed.row_count, 250);
    assert!(!streamed.truncated);
    let data_chunks: Vec<_> = sink.0.iter().filter(|chunk| !chunk.rows.is_empty()).collect();
    assert_eq!(data_chunks.len(), 3);
    assert_eq!(data_chunks[0].rows.len(), 100);
    assert_eq!(data_chunks[1].rows.len(), 100);
    assert_eq!(data_chunks[2].rows.len(), 50);
    assert!(data_chunks[0].columns.len() == 1);
    assert!(data_chunks[1].columns.is_empty());
    assert_eq!(data_chunks[0].rows[0][0], SqlValue::Int(1));
    assert_eq!(data_chunks[2].rows[49][0], SqlValue::Int(250));

    let mut sink = VecSink(Vec::new());
    let cancelled = driver
        .query(
            &id,
            &request("SELECT n FROM numbers", 50, Arc::new(AtomicBool::new(true))),
            &mut sink,
        )
        .await
        .expect("cancel");
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.row_count, 0);
    assert!(sink.0.last().is_some_and(|chunk| chunk.last));

    driver.disconnect(&id).await.expect("disconnect");
    let mut sink = VecSink(Vec::new());
    let missing = driver
        .query(&id, &request("SELECT 1", 10, Arc::new(AtomicBool::new(false))), &mut sink)
        .await;
    assert!(matches!(missing, Err(CoreError::NotConnected(_))));
}

#[tokio::test]
async fn sqlite_probe_reports_a_version_without_keeping_the_session() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    let version = driver.probe(&connection, None, None).await.expect("probe");
    assert!(version.contains('.'));
    let id = connection.connection_id().expect("id");
    let missing = driver.list_relations(&id).await;
    assert!(matches!(missing, Err(CoreError::NotConnected(_))));
}

async fn run(driver: &SqliteDriver, id: &gridl_core::ConnectionId, sql: &str) -> Vec<RowChunk> {
    let mut sink = VecSink(Vec::new());
    driver
        .query(id, &request(sql, DEFAULT_CHUNK_ROWS, Arc::new(AtomicBool::new(false))), &mut sink)
        .await
        .expect(sql);
    sink.0
}

fn count(chunks: &[RowChunk]) -> SqlValue {
    chunks.iter().flat_map(|chunk| chunk.rows.iter()).next().expect("row")[0].clone()
}

#[tokio::test]
async fn sqlite_editor_transactions_span_queries() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    driver.connect(&connection, None, None).await.expect("connect");
    let id = connection.connection_id().expect("id");

    run(&driver, &id, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await;
    run(&driver, &id, "BEGIN").await;
    run(&driver, &id, "INSERT INTO items (name) VALUES ('draft')").await;
    assert_eq!(count(&run(&driver, &id, "SELECT count(*) FROM items").await), SqlValue::Int(1));
    run(&driver, &id, "ROLLBACK").await;
    assert_eq!(count(&run(&driver, &id, "SELECT count(*) FROM items").await), SqlValue::Int(0));

    run(&driver, &id, "CREATE TEMP TABLE scratch (n INTEGER)").await;
    run(&driver, &id, "INSERT INTO scratch VALUES (7)").await;
    assert_eq!(count(&run(&driver, &id, "SELECT n FROM scratch").await), SqlValue::Int(7));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn sqlite_batch_commits_all_or_nothing() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    driver.connect(&connection, None, None).await.expect("connect");
    let id = connection.connection_id().expect("id");
    run(&driver, &id, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").await;

    let statement = |sql: &str, params: Vec<SqlValue>| BatchStatement { sql: sql.into(), params };
    let good = BatchRequest::new(vec![
        statement(
            "INSERT INTO items (id, name) VALUES (?1, ?2)",
            vec![SqlValue::Int(1), SqlValue::Text("a".into())],
        ),
        statement(
            "INSERT INTO items (id, name) VALUES (?1, ?2)",
            vec![SqlValue::Int(2), SqlValue::Text("b".into())],
        ),
    ])
    .expect("batch");
    let done = driver.execute_batch(&id, &good).await.expect("commit");
    assert_eq!(done.rows_affected, 2);
    assert_eq!(done.statements, 2);

    let bad = BatchRequest::new(vec![
        statement("UPDATE items SET name = 'changed' WHERE id = 1", Vec::new()),
        statement("INSERT INTO items (id, name) VALUES (3, NULL)", Vec::new()),
    ])
    .expect("batch");
    let failed = driver.execute_batch(&id, &bad).await;
    assert!(matches!(&failed, Err(CoreError::Statement { number: 2, .. })));
    let names = run(&driver, &id, "SELECT name FROM items WHERE id = 1").await;
    assert_eq!(count(&names), SqlValue::Text("a".into()));
    assert_eq!(count(&run(&driver, &id, "SELECT count(*) FROM items").await), SqlValue::Int(2));

    assert!(BatchRequest::new(Vec::new()).is_err());
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn sqlite_check_parses_without_running() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    driver.connect(&connection, None, None).await.expect("connect");
    let id = connection.connection_id().expect("id");
    run(&driver, &id, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await;

    assert!(driver.check(&id, "SELECT name FROM items").await.expect("check").problem.is_none());
    let missing = driver.check(&id, "SELECT nope FROM items").await.expect("check");
    assert!(missing.problem.expect("problem").message.contains("nope"));
    assert!(driver.check(&id, "DELETE FROM items").await.expect("check").problem.is_none());
    run(&driver, &id, "INSERT INTO items (name) VALUES ('a')").await;
    driver.check(&id, "DELETE FROM items").await.expect("check");
    assert_eq!(count(&run(&driver, &id, "SELECT count(*) FROM items").await), SqlValue::Int(1));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn sqlite_lists_foreign_keys() {
    let file = TempDb::new();
    let driver = SqliteDriver::new();
    let connection = config(&file.path);
    driver.connect(&connection, None, None).await.expect("connect");
    let id = connection.connection_id().expect("id");
    run(&driver, &id, "CREATE TABLE customer (id INTEGER PRIMARY KEY)").await;
    run(&driver, &id, "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer ON DELETE CASCADE, a INT, b INT, FOREIGN KEY (a, b) REFERENCES pair (x, y))").await;
    let keys = driver.foreign_keys(&id).await.expect("foreign keys");
    assert_eq!(keys.len(), 2);
    let simple = keys.iter().find(|key| key.ref_table == "customer").expect("customer fk");
    assert_eq!(simple.columns, vec!["customer_id".to_owned()]);
    assert!(simple.ref_columns.is_empty());
    assert_eq!(simple.on_delete, "CASCADE");
    let pair = keys.iter().find(|key| key.ref_table == "pair").expect("pair fk");
    assert_eq!(pair.columns, vec!["a".to_owned(), "b".to_owned()]);
    assert_eq!(pair.ref_columns, vec!["x".to_owned(), "y".to_owned()]);
    driver.disconnect(&id).await.expect("disconnect");
}

/// SQLite stores each value with its own class whatever the column declares; every
/// class must read back as itself in every kind of declared column.
#[tokio::test]
async fn sqlite_reads_and_writes_back_every_storage_class_in_every_column_type() {
    let db = TempDb::new();
    let driver = SqliteDriver::new();
    let config = config(&db.path);
    driver.connect(&config, None, None).await.expect("connect");
    let id = config.connection_id().expect("id");
    let declared = [
        ("c_int", "INTEGER"),
        ("c_real", "REAL"),
        ("c_text", "TEXT"),
        ("c_blob", "BLOB"),
        ("c_num", "NUMERIC"),
        ("c_decimal", "DECIMAL(10,2)"),
        ("c_bool", "BOOLEAN"),
        ("c_date", "DATETIME"),
        ("c_json", "JSON"),
        ("c_varchar", "VARCHAR(10)"),
        ("c_any", ""),
    ];
    let samples = [
        "42",
        "-9223372036854775808",
        "2.5",
        "1e308",
        "'héllo ✓'",
        "'123'",
        "'2026-06-12 10:00:00'",
        "X'00FF'",
        "X'68656C6C6F'",
        "0",
        "1",
        "NULL",
    ];
    let columns: Vec<String> =
        declared.iter().map(|(name, kind)| format!("{name} {kind}")).collect();
    run(&driver, &id, &format!("CREATE TABLE t (id INTEGER PRIMARY KEY, {})", columns.join(", ")))
        .await;
    for (row, sample) in samples.iter().enumerate() {
        let values = vec![*sample; declared.len()].join(", ");
        let names: Vec<&str> = declared.iter().map(|(name, _)| *name).collect();
        run(
            &driver,
            &id,
            &format!("INSERT INTO t (id, {}) VALUES ({}, {values})", names.join(", "), row + 1),
        )
        .await;
    }

    let names: Vec<&str> = declared.iter().map(|(name, _)| *name).collect();
    let select = format!("SELECT {} FROM t ORDER BY id", names.join(", "));
    let rows: Vec<Vec<SqlValue>> =
        run(&driver, &id, &select).await.into_iter().flat_map(|chunk| chunk.rows).collect();
    // What SQLite stored: its class, its text, its bytes.
    let probes: Vec<String> = names
        .iter()
        .map(|name| format!(
                "typeof({name}), CASE typeof({name}) WHEN 'real' THEN printf('%!.17g', {name}) ELSE CAST({name} AS TEXT) END, hex({name})"
            ))
        .collect();
    let stored: Vec<Vec<SqlValue>> =
        run(&driver, &id, &format!("SELECT {} FROM t ORDER BY id", probes.join(", ")))
            .await
            .into_iter()
            .flat_map(|chunk| chunk.rows)
            .collect();

    let text = |value: &SqlValue| match value {
        SqlValue::Text(text) => text.clone(),
        other => panic!("probe {other:?}"),
    };
    for (row, sample) in samples.iter().enumerate() {
        for (column, (name, kind)) in declared.iter().enumerate() {
            let class = text(&stored[row][column * 3]);
            let value = &rows[row][column];
            let ok = match class.as_str() {
                "null" => *value == SqlValue::Null,
                "integer" => {
                    let expected: i64 = text(&stored[row][column * 3 + 1]).parse().expect("int");
                    *value == SqlValue::Int(expected)
                        || (*kind == "BOOLEAN"
                            && (expected == 0 || expected == 1)
                            && *value == SqlValue::Bool(expected == 1))
                }
                "real" => {
                    let expected: f64 = text(&stored[row][column * 3 + 1]).parse().expect("real");
                    *value == SqlValue::Float(expected)
                }
                "text" => *value == SqlValue::Text(text(&stored[row][column * 3 + 1])),
                "blob" => {
                    let hex = text(&stored[row][column * 3 + 2]);
                    let bytes: Vec<u8> = (0..hex.len())
                        .step_by(2)
                        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex"))
                        .collect();
                    *value == SqlValue::Bytes(bytes)
                }
                other => panic!("class {other}"),
            };
            assert!(ok, "{name} ({kind}) holding {sample} stored as {class} reads as {value:?}");
        }
    }

    // Saving each cell back must keep its class and value.
    for (row, _) in samples.iter().enumerate() {
        for (column, (name, kind)) in declared.iter().enumerate() {
            let batch = BatchRequest::new(vec![BatchStatement {
                sql: format!("UPDATE t SET {name} = ? WHERE id = ?"),
                params: vec![rows[row][column].clone(), SqlValue::Int(row as i64 + 1)],
            }])
            .expect("batch");
            driver
                .execute_batch(&id, &batch)
                .await
                .unwrap_or_else(|err| panic!("{name} ({kind}): {err}"));
        }
    }
    let again: Vec<Vec<SqlValue>> =
        run(&driver, &id, &format!("SELECT {} FROM t ORDER BY id", probes.join(", ")))
            .await
            .into_iter()
            .flat_map(|chunk| chunk.rows)
            .collect();
    assert_eq!(again, stored, "every value keeps its class and content after saving it back");
    driver.disconnect(&id).await.expect("disconnect");
}

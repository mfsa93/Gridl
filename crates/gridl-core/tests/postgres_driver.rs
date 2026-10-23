//! Runs against a live server when `GRIDL_TEST_PG` is set, for example
//! `GRIDL_TEST_PG=postgres:gridl@127.0.0.1:35432/gridl`. Skipped otherwise.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError,
    DatabaseDriver, DatabaseEngine, PostgresDriver, QueryRequest, RowChunk, SecretString, SqlValue,
    TlsMode, DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
};

struct VecSink(Vec<RowChunk>);

#[async_trait]
impl ChunkSink for VecSink {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.0.push(chunk);
        Ok(())
    }
}

struct Target {
    user: String,
    password: String,
    host: String,
    port: u16,
    database: String,
}

fn target() -> Option<Target> {
    let raw = std::env::var("GRIDL_TEST_PG").ok()?;
    let (credentials, rest) = raw.split_once('@')?;
    let (user, password) = credentials.split_once(':')?;
    let (address, database) = rest.split_once('/')?;
    let (host, port) = address.split_once(':')?;
    Some(Target {
        user: user.into(),
        password: password.into(),
        host: host.into(),
        port: port.parse().ok()?,
        database: database.into(),
    })
}

fn config(target: &Target, id: &str, read_only: bool) -> ConnectionConfig {
    let mut config = ConnectionConfig {
        id: id.into(),
        name: id.into(),
        engine: DatabaseEngine::Postgres,
        database: target.database.clone(),
        host: Some(target.host.clone()),
        port: Some(target.port),
        username: Some(target.user.clone()),
        credential_account: None,
        group: None,
        read_only,
        create_if_missing: false,
        tls: gridl_core::TlsSettings::default(),
        ssh: gridl_core::SshSettings::default(),
        safety: gridl_core::SafetySettings::default(),
    };
    config.tls.mode = TlsMode::Disable;
    config
}

async fn open(target: &Target, id: &str, read_only: bool) -> (PostgresDriver, ConnectionId) {
    let driver = PostgresDriver::new();
    let config = config(target, id, read_only);
    let secret = SecretString::new(target.password.clone());
    driver.connect(&config, Some(&secret), None).await.expect("connect");
    (driver, config.connection_id().expect("id"))
}

fn request(sql: &str, cancel: Arc<AtomicBool>) -> QueryRequest {
    QueryRequest::new("query-1", sql, Vec::new(), DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS, cancel)
        .expect("request")
}

async fn run(driver: &PostgresDriver, id: &ConnectionId, sql: &str) -> Vec<RowChunk> {
    try_run(driver, id, sql).await.expect(sql)
}

async fn try_run(
    driver: &PostgresDriver,
    id: &ConnectionId,
    sql: &str,
) -> Result<Vec<RowChunk>, CoreError> {
    let mut sink = VecSink(Vec::new());
    driver.query(id, &request(sql, Arc::new(AtomicBool::new(false))), &mut sink).await?;
    Ok(sink.0)
}

fn first(chunks: &[RowChunk]) -> SqlValue {
    chunks.iter().flat_map(|chunk| chunk.rows.iter()).next().expect("row")[0].clone()
}

#[tokio::test]
async fn postgres_editor_session_keeps_transactions_and_enums() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-session", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_items").await;
    run(&driver, &id, "DROP TYPE IF EXISTS gridl_mood").await;
    run(&driver, &id, "CREATE TYPE gridl_mood AS ENUM ('ok', 'sad')").await;
    run(&driver, &id, "CREATE TABLE gridl_items (id serial PRIMARY KEY, mood gridl_mood)").await;

    run(&driver, &id, "BEGIN").await;
    run(&driver, &id, "INSERT INTO gridl_items (mood) VALUES ('ok')").await;
    assert_eq!(
        first(&run(&driver, &id, "SELECT count(*) FROM gridl_items").await),
        SqlValue::Int(1)
    );
    run(&driver, &id, "ROLLBACK").await;
    assert_eq!(
        first(&run(&driver, &id, "SELECT count(*) FROM gridl_items").await),
        SqlValue::Int(0)
    );

    run(&driver, &id, "SET search_path TO pg_catalog, public").await;
    run(&driver, &id, "CREATE TEMP TABLE gridl_scratch (n int)").await;
    run(&driver, &id, "INSERT INTO gridl_scratch VALUES (7)").await;
    assert_eq!(first(&run(&driver, &id, "SELECT n FROM gridl_scratch").await), SqlValue::Int(7));

    let tables = driver.introspect(&id).await.expect("introspect");
    let items = tables.iter().find(|table| table.name == "gridl_items").expect("items");
    let mood = items.columns.iter().find(|column| column.name == "mood").expect("mood");
    assert_eq!(mood.options, vec!["ok".to_owned(), "sad".to_owned()]);

    let chunks = run(&driver, &id, "SELECT mood FROM gridl_items").await;
    assert_eq!(chunks[0].columns[0].options, vec!["ok".to_owned(), "sad".to_owned()]);

    // A failed statement must not poison later queries outside a transaction.
    assert!(try_run(&driver, &id, "SELECT * FROM gridl_missing").await.is_err());
    assert_eq!(first(&run(&driver, &id, "SELECT 1").await), SqlValue::Int(1));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn postgres_batch_rolls_back_on_failure() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-batch", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_batch").await;
    run(&driver, &id, "CREATE TABLE gridl_batch (id int PRIMARY KEY, name text NOT NULL)").await;
    let statement = |sql: &str, params: Vec<SqlValue>| BatchStatement { sql: sql.into(), params };

    let good = BatchRequest::new(vec![
        statement(
            "INSERT INTO gridl_batch VALUES ($1, $2)",
            vec![SqlValue::Int(1), SqlValue::Text("a".into())],
        ),
        statement("ALTER TABLE gridl_batch ADD COLUMN note text", Vec::new()),
    ])
    .expect("batch");
    assert_eq!(driver.execute_batch(&id, &good).await.expect("commit").rows_affected, 1);

    let bad = BatchRequest::new(vec![
        statement("UPDATE gridl_batch SET name = 'changed'", Vec::new()),
        statement("INSERT INTO gridl_batch VALUES (1, 'dup')", Vec::new()),
    ])
    .expect("batch");
    let failed = driver.execute_batch(&id, &bad).await;
    assert!(matches!(&failed, Err(CoreError::Statement { number: 2, .. })));
    let name = first(&run(&driver, &id, "SELECT name FROM gridl_batch WHERE id = 1").await);
    assert_eq!(name, SqlValue::Text("a".into()));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn postgres_read_only_is_enforced_by_the_server() {
    let Some(target) = target() else { return };
    let (writer, writer_id) = open(&target, "pg-writer", false).await;
    run(&writer, &writer_id, "CREATE TABLE IF NOT EXISTS gridl_ro (n int)").await;
    writer.disconnect(&writer_id).await.expect("disconnect");

    let (driver, id) = open(&target, "pg-reader", true).await;
    let denied = try_run(&driver, &id, "INSERT INTO gridl_ro VALUES (1)").await;
    assert!(matches!(&denied, Err(CoreError::Database(message)) if message.contains("read-only")));
    let batch = BatchRequest::new(vec![BatchStatement {
        sql: "DELETE FROM gridl_ro".into(),
        params: Vec::new(),
    }])
    .expect("batch");
    assert!(driver.execute_batch(&id, &batch).await.is_err());
    run(&driver, &id, "SELECT count(*) FROM gridl_ro").await;
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn postgres_cancel_stops_a_running_statement() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-cancel", false).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        flag.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    let mut sink = VecSink(Vec::new());
    let result = driver
        .query(&id, &request("SELECT pg_sleep(10)", cancel), &mut sink)
        .await
        .expect("cancel");
    assert!(result.cancelled);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(sink.0.last().is_some_and(|chunk| chunk.last));

    // Cancel a stream mid-result; the next query must not drain the leftovers.
    let cancel = Arc::new(AtomicBool::new(false));
    struct StopAfterFirst(Vec<RowChunk>, Arc<AtomicBool>);
    #[async_trait]
    impl ChunkSink for StopAfterFirst {
        async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
            self.1.store(true, Ordering::Relaxed);
            self.0.push(chunk);
            Ok(())
        }
    }
    let mut sink = StopAfterFirst(Vec::new(), Arc::clone(&cancel));
    let started = Instant::now();
    let streamed = driver
        .query(&id, &request("SELECT g FROM generate_series(1, 50000000) g", cancel), &mut sink)
        .await
        .expect("stream cancel");
    assert!(streamed.cancelled);
    assert_eq!(first(&run(&driver, &id, "SELECT 42").await), SqlValue::Int(42));
    assert!(started.elapsed() < Duration::from_secs(5));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn postgres_check_reports_position_without_touching_the_editor() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-check", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_check").await;
    run(&driver, &id, "CREATE TABLE gridl_check (role_id text)").await;

    let sql = r#"select * from gridl_check where role_id="037bd1bb""#;
    let check = driver.check(&id, sql).await.expect("check");
    let problem = check.problem.expect("problem");
    assert_eq!(problem.code.as_deref(), Some("42703"));
    let position = problem.position.expect("position") as usize;
    assert_eq!(&sql[position - 1..position + 9], r#""037bd1bb""#);

    assert_eq!(
        driver.check(&id, "select * from gridl_check where role_id = $1").await.expect("check"),
        gridl_core::SqlCheck::clean()
    );
    assert!(driver.check(&id, "selec 1").await.expect("check").problem.is_some());

    // A failed check must not abort a transaction the editor has open.
    run(&driver, &id, "BEGIN").await;
    run(&driver, &id, "INSERT INTO gridl_check VALUES ('kept')").await;
    assert!(driver
        .check(&id, "select nope from gridl_check")
        .await
        .expect("check")
        .problem
        .is_some());
    run(&driver, &id, "COMMIT").await;
    assert_eq!(
        first(&run(&driver, &id, "SELECT count(*) FROM gridl_check").await),
        SqlValue::Int(1)
    );
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn postgres_lists_foreign_keys_in_column_order() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-fk", false).await;
    for sql in [
        "DROP TABLE IF EXISTS gridl_line, gridl_order, gridl_customer",
        "CREATE TABLE gridl_customer (id int PRIMARY KEY)",
        "CREATE TABLE gridl_order (id int, region text, customer_id int REFERENCES gridl_customer (id) ON DELETE CASCADE, PRIMARY KEY (region, id))",
        "CREATE TABLE gridl_line (n int, order_region text, order_id int, CONSTRAINT gridl_line_order FOREIGN KEY (order_region, order_id) REFERENCES gridl_order (region, id) ON UPDATE SET NULL)",
    ] {
        run(&driver, &id, sql).await;
    }
    let keys = driver.foreign_keys(&id).await.expect("foreign keys");
    let order = keys.iter().find(|key| key.table == "gridl_order").expect("order fk");
    assert_eq!(order.columns, vec!["customer_id".to_owned()]);
    assert_eq!(order.ref_table, "gridl_customer");
    assert_eq!(order.ref_columns, vec!["id".to_owned()]);
    assert_eq!(order.on_delete, "CASCADE");
    assert_eq!(order.on_update, "NO ACTION");
    let line = keys.iter().find(|key| key.name == "gridl_line_order").expect("line fk");
    assert_eq!(line.columns, vec!["order_region".to_owned(), "order_id".to_owned()]);
    assert_eq!(line.ref_columns, vec!["region".to_owned(), "id".to_owned()]);
    assert_eq!(line.on_update, "SET NULL");
    assert_eq!(line.schema.as_deref(), Some("public"));
    driver.disconnect(&id).await.expect("disconnect");
}

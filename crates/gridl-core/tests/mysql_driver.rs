//! Runs against a live MySQL or MariaDB server named by `GRIDL_TEST_MYSQL`,
//! formatted as `user:password@host:port/database`. Every test returns early
//! when the variable is unset, so CI passes without a server.
//!
//! ```text
//! docker run -d --rm --name gridl-mysql-test -e MYSQL_ROOT_PASSWORD=gridl \
//!   -e MYSQL_DATABASE=gridl -p 33306:3306 mysql:8.4
//! GRIDL_TEST_MYSQL=root:gridl@127.0.0.1:33306/gridl cargo test -p gridl-core --test mysql_driver
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError,
    DatabaseDriver, DatabaseEngine, MysqlDriver, QueryRequest, QueryResult, RelationKind, RowChunk,
    SecretString, SqlValue, TableSchema, DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
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
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
}

fn target() -> Option<Target> {
    let raw = std::env::var("GRIDL_TEST_MYSQL").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (credentials, location) = raw.rsplit_once('@').expect("user:password@host:port/db");
    let (user, password) = credentials.split_once(':').unwrap_or((credentials, ""));
    let (address, database) = location.split_once('/').expect("missing /database");
    let (host, port) = address.rsplit_once(':').unwrap_or((address, "3306"));
    Some(Target {
        host: host.to_owned(),
        port: port.parse().expect("port"),
        user: user.to_owned(),
        password: password.to_owned(),
        database: database.to_owned(),
    })
}

fn config(target: &Target, id: &str, read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: "MySQL test".into(),
        engine: DatabaseEngine::Mysql,
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
    }
}

async fn open(target: &Target, id: &str, read_only: bool) -> (MysqlDriver, ConnectionId) {
    let driver = MysqlDriver::new();
    let connection = config(target, id, read_only);
    let password = SecretString::new(target.password.clone());
    driver.connect(&connection, Some(&password), None).await.expect("connect");
    (driver, connection.connection_id().expect("id"))
}

fn request(sql: &str, chunk_rows: usize, cancel: Arc<AtomicBool>) -> QueryRequest {
    QueryRequest::new("query-1", sql, Vec::new(), chunk_rows, MAX_STREAM_ROWS, cancel)
        .expect("request")
}

async fn try_run(
    driver: &MysqlDriver,
    id: &ConnectionId,
    sql: &str,
) -> Result<(QueryResult, Vec<RowChunk>), CoreError> {
    let mut sink = VecSink(Vec::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let result = driver.query(id, &request(sql, DEFAULT_CHUNK_ROWS, cancel), &mut sink).await?;
    Ok((result, sink.0))
}

async fn run(driver: &MysqlDriver, id: &ConnectionId, sql: &str) -> Vec<Vec<SqlValue>> {
    let (_, chunks) = try_run(driver, id, sql).await.unwrap_or_else(|err| panic!("{sql}: {err}"));
    chunks.into_iter().flat_map(|chunk| chunk.rows).collect()
}

async fn count(driver: &MysqlDriver, id: &ConnectionId, table: &str) -> i64 {
    match run(driver, id, &format!("SELECT COUNT(*) FROM {table}")).await[0][0] {
        SqlValue::Int(value) => value,
        ref other => panic!("count is {other:?}"),
    }
}

fn find<'a>(schema: &'a [TableSchema], name: &str, kind: RelationKind) -> &'a TableSchema {
    schema
        .iter()
        .find(|table| table.name == name && table.kind == kind)
        .unwrap_or_else(|| panic!("{name} ({kind:?}) missing"))
}

#[tokio::test]
async fn mysql_introspects_keys_enums_and_auto_increment() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-introspect", false).await;
    let version = driver
        .probe(
            &config(&target, "mysql-probe", false),
            Some(&SecretString::new(target.password.clone())),
            None,
        )
        .await
        .expect("probe");
    assert!(version.starts_with("MySQL ") || version.starts_with("MariaDB "), "{version}");

    for sql in [
        "DROP VIEW IF EXISTS gi_view",
        "DROP FUNCTION IF EXISTS gi_double",
        "DROP PROCEDURE IF EXISTS gi_touch",
        "DROP TABLE IF EXISTS gi_items",
        "CREATE TABLE gi_items (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            status ENUM('new','it''s done','a,b','back\\\\slash') NOT NULL DEFAULT 'new',
            tags SET('x','y') NULL,
            price DECIMAL(30,10) NULL,
            big BIGINT UNSIGNED NULL,
            doc JSON NULL,
            payload BLOB NULL,
            note VARCHAR(255) NULL,
            flag BOOLEAN NULL,
            ratio DOUBLE NULL,
            born DATE NULL,
            created DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
            span TIME NULL,
            code VARCHAR(10) COLLATE utf8mb4_bin NULL,
            KEY gi_items_note (note(20), created DESC)
        )",
        "CREATE VIEW gi_view AS SELECT id, status FROM gi_items",
        "CREATE TRIGGER gi_items_bi BEFORE INSERT ON gi_items FOR EACH ROW SET NEW.note = COALESCE(NEW.note, 'auto')",
        "CREATE FUNCTION gi_double(value INT) RETURNS INT DETERMINISTIC RETURN value * 2",
        "CREATE PROCEDURE gi_touch(IN amount INT, OUT result INT) SET result = amount + 1",
        "INSERT INTO gi_items (status, tags, price, big, doc, payload, flag, ratio, born, created, span, code)
         VALUES ('it''s done', 'x,y', 12345678901234567890.0123456789, 18446744073709551615,
                 '{\"a\": [1, 2]}', X'00FF10', TRUE, 1.5, '2024-03-09',
                 '2024-03-09 13:05:07.120', '-26:03:04', 'ABC')",
    ] {
        run(&driver, &id, sql).await;
    }

    let schema = driver.introspect(&id).await.expect("introspect");
    let items = find(&schema, "gi_items", RelationKind::Table);
    assert_eq!(items.schema.as_deref(), Some(target.database.as_str()));
    let column = |name: &str| {
        items.columns.iter().find(|column| column.name == name).expect("column").clone()
    };
    let id_column = column("id");
    assert!(id_column.primary_key);
    assert!(!id_column.nullable);
    // MySQL 8 drops the display width ("int unsigned"); MariaDB keeps it ("int(10) unsigned").
    assert!(
        id_column.data_type.starts_with("int") && id_column.data_type.ends_with("unsigned"),
        "{}",
        id_column.data_type
    );
    assert_eq!(id_column.default_value.as_deref(), Some("auto_increment"));
    let status = column("status");
    assert_eq!(status.options, vec!["new", "it's done", "a,b", r"back\slash"]);
    assert!(!status.primary_key);
    assert!(status.default_value.as_deref().is_some_and(|value| value.contains("new")));
    assert_eq!(column("tags").options, vec!["x", "y"]);
    assert_eq!(column("note").data_type, "varchar(255)");
    assert_eq!(column("note").default_value, None);
    assert!(column("note").nullable);

    let view = find(&schema, "gi_view", RelationKind::View);
    assert_eq!(view.columns.len(), 2);
    assert!(view.definition.as_deref().is_some_and(|body| body.contains("gi_items")));
    let function = find(&schema, "gi_double", RelationKind::Function);
    assert_eq!(function.columns[0].name, "value");
    assert!(function.definition.as_deref().is_some_and(|body| body.contains("RETURNS int")));
    assert_eq!(function.returns.as_deref(), Some("int"));
    let procedure = find(&schema, "gi_touch", RelationKind::Procedure);
    assert_eq!(procedure.columns.len(), 2);
    assert_eq!(procedure.returns, None);
    let modes: Vec<_> = procedure.columns.iter().map(|column| column.mode.as_deref()).collect();
    assert_eq!(modes, vec![Some("IN"), Some("OUT")]);
    assert_eq!(function.columns[0].mode.as_deref(), Some("IN"));
    let trigger = find(&schema, "gi_items_bi", RelationKind::Trigger);
    assert!(trigger.definition.as_deref().is_some_and(|body| body.contains("BEFORE INSERT")));
    let index = find(&schema, "gi_items.gi_items_note", RelationKind::Index);
    assert_eq!(
        index.definition.as_deref(),
        Some("CREATE INDEX `gi_items_note` ON `gi_items` (`note`(20), `created` DESC)")
    );
    find(&schema, "gi_items.PRIMARY", RelationKind::Index);

    let relations = driver.list_relations(&id).await.expect("relations");
    assert!(relations
        .iter()
        .any(|relation| relation.name == "gi_view" && relation.kind == RelationKind::View));
    let described = driver
        .describe_relation(&id, &relations.into_iter().find(|r| r.name == "gi_items").unwrap())
        .await
        .expect("describe");
    assert_eq!(described.columns, items.columns);

    let rows = run(
        &driver,
        &id,
        "SELECT id, status, tags, price, big, doc, payload, note, flag, ratio, born, created,
                span, NULL AS nothing, code
         FROM gi_items",
    )
    .await;
    let row = &rows[0];
    assert_eq!(row[0], SqlValue::Int(1));
    assert_eq!(row[1], SqlValue::Text("it's done".into()));
    assert_eq!(row[2], SqlValue::Text("x,y".into()));
    assert_eq!(row[3], SqlValue::Text("12345678901234567890.0123456789".into()));
    assert_eq!(row[4], SqlValue::Text("18446744073709551615".into()));
    match &row[5] {
        SqlValue::Text(json) => assert!(json.contains("\"a\""), "{json}"),
        other => panic!("json decoded as {other:?}"),
    }
    assert_eq!(row[6], SqlValue::Bytes(vec![0x00, 0xFF, 0x10]));
    assert_eq!(row[7], SqlValue::Text("auto".into()));
    assert_eq!(row[8], SqlValue::Int(1));
    assert_eq!(row[9], SqlValue::Float(1.5));
    assert_eq!(row[10], SqlValue::Text("2024-03-09".into()));
    assert_eq!(row[11], SqlValue::Text("2024-03-09 13:05:07.120".into()));
    assert_eq!(row[12], SqlValue::Text("-26:03:04".into()));
    assert_eq!(row[13], SqlValue::Null);
    // A `_bin` collation is flagged like a binary string but reads as text.
    assert_eq!(row[14], SqlValue::Text("ABC".into()));

    // With parameters the values read exactly as without them.
    let mut sink = VecSink(Vec::new());
    let with_params = QueryRequest::new(
        "query-params",
        "SELECT born, created, span, price FROM gi_items WHERE id = ?",
        vec![SqlValue::Int(1)],
        DEFAULT_CHUNK_ROWS,
        MAX_STREAM_ROWS,
        Arc::new(AtomicBool::new(false)),
    )
    .expect("request");
    driver.query(&id, &with_params, &mut sink).await.expect("select with parameters");
    assert_eq!(
        sink.0[0].rows[0],
        vec![
            SqlValue::Text("2024-03-09".into()),
            SqlValue::Text("2024-03-09 13:05:07.120".into()),
            SqlValue::Text("-26:03:04".into()),
            SqlValue::Text("12345678901234567890.0123456789".into()),
        ]
    );

    for sql in [
        "DROP VIEW gi_view",
        "DROP FUNCTION gi_double",
        "DROP PROCEDURE gi_touch",
        "DROP TABLE gi_items",
    ] {
        run(&driver, &id, sql).await;
    }
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_streams_chunks() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-stream", false).await;
    let mut sink = VecSink(Vec::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let sql = "SELECT a.n * 100 + b.n * 10 + c.n AS n, CONCAT('row ', a.n, b.n, c.n) AS label
               FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
                     UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
               CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
                     UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
               CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
                     UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
               ORDER BY n";
    let result = driver.query(&id, &request(sql, 128, cancel), &mut sink).await.expect("query");
    assert_eq!(result.row_count, 1000);
    assert!(!result.cancelled && !result.truncated);
    let chunks = sink.0;
    assert_eq!(chunks.len(), 8);
    assert_eq!(chunks[0].columns.len(), 2);
    assert_eq!(chunks[0].columns[0].name, "n");
    assert!(chunks[1..].iter().all(|chunk| chunk.columns.is_empty()));
    assert!(chunks[..7].iter().all(|chunk| chunk.rows.len() == 128 && !chunk.last));
    assert!(chunks[7].last);
    assert_eq!(chunks[7].rows.len(), 1000 - 7 * 128);
    assert_eq!(chunks[7].rows.last().unwrap()[1], SqlValue::Text("row 999".into()));

    // An empty result still carries its header.
    let (result, chunks) =
        try_run(&driver, &id, "SELECT 1 AS one FROM DUAL WHERE 1 = 0").await.expect("empty select");
    assert_eq!(result.row_count, 0);
    assert_eq!(chunks[0].columns[0].name, "one");
    assert!(chunks[0].last);

    // Statements the prepared protocol rejects still run through the editor.
    let rows = run(&driver, &id, "SHOW VARIABLES LIKE 'version'").await;
    assert_eq!(rows[0][0], SqlValue::Text("version".into()));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_editor_transactions_span_queries() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-tx", false).await;
    let (observer, observer_id) = open(&target, "mysql-tx-observer", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gt_tx").await;
    run(&driver, &id, "CREATE TABLE gt_tx (id INT PRIMARY KEY) ENGINE=InnoDB").await;

    run(&driver, &id, "BEGIN").await;
    let (result, _) = try_run(&driver, &id, "INSERT INTO gt_tx VALUES (1), (2)").await.unwrap();
    assert_eq!(result.rows_affected, 2);
    assert_eq!(count(&driver, &id, "gt_tx").await, 2);
    assert_eq!(count(&observer, &observer_id, "gt_tx").await, 0);
    run(&driver, &id, "ROLLBACK").await;
    assert_eq!(count(&driver, &id, "gt_tx").await, 0);

    run(&driver, &id, "SET @gridl_marker = 41").await;
    assert_eq!(run(&driver, &id, "SELECT @gridl_marker + 1").await[0][0], SqlValue::Int(42));

    run(&driver, &id, "DROP TABLE gt_tx").await;
    observer.disconnect(&observer_id).await.expect("disconnect");
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_batch_rolls_back_on_failure() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-batch", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gt_batch").await;
    run(&driver, &id, "CREATE TABLE gt_batch (id INT PRIMARY KEY, label TEXT) ENGINE=InnoDB").await;

    let insert = |id: i64| BatchStatement {
        sql: "INSERT INTO gt_batch (id, label) VALUES (?, ?)".into(),
        params: vec![SqlValue::Int(id), SqlValue::Text(format!("label {id}"))],
    };
    let failing = BatchRequest::new(vec![insert(1), insert(1)]).expect("batch");
    let err = driver.execute_batch(&id, &failing).await.expect_err("duplicate key");
    match &err {
        CoreError::Statement { number, .. } => assert_eq!(*number, 2, "{err}"),
        other => panic!("unexpected error {other:?}"),
    }
    assert_eq!(count(&driver, &id, "gt_batch").await, 0);

    let ok = BatchRequest::new(vec![
        insert(1),
        insert(2),
        BatchStatement {
            sql: "UPDATE gt_batch SET label = ? WHERE id = ?".into(),
            params: vec![SqlValue::Null, SqlValue::Int(2)],
        },
    ])
    .expect("batch");
    let result = driver.execute_batch(&id, &ok).await.expect("commit");
    assert_eq!(result.statements, 3);
    assert_eq!(result.rows_affected, 3);
    assert_eq!(
        run(&driver, &id, "SELECT label FROM gt_batch ORDER BY id").await,
        vec![vec![SqlValue::Text("label 1".into())], vec![SqlValue::Null]]
    );

    run(&driver, &id, "DROP TABLE gt_batch").await;
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_read_only_connection_rejects_writes() {
    let Some(target) = target() else {
        return;
    };
    let (writer, writer_id) = open(&target, "mysql-ro-writer", false).await;
    run(&writer, &writer_id, "DROP TABLE IF EXISTS gt_ro").await;
    run(&writer, &writer_id, "CREATE TABLE gt_ro (id INT PRIMARY KEY) ENGINE=InnoDB").await;
    run(&writer, &writer_id, "INSERT INTO gt_ro VALUES (1)").await;

    let (reader, reader_id) = open(&target, "mysql-ro-reader", true).await;
    assert_eq!(count(&reader, &reader_id, "gt_ro").await, 1);
    let err = try_run(&reader, &reader_id, "INSERT INTO gt_ro VALUES (2)")
        .await
        .expect_err("insert on a read-only connection");
    assert!(err.to_string().to_ascii_lowercase().contains("read only"), "{err}");
    let err = try_run(&reader, &reader_id, "UPDATE gt_ro SET id = 3")
        .await
        .expect_err("update on a read-only connection");
    assert!(err.to_string().to_ascii_lowercase().contains("read only"), "{err}");
    let batch = BatchRequest::new(vec![BatchStatement {
        sql: "DELETE FROM gt_ro".into(),
        params: Vec::new(),
    }])
    .expect("batch");
    reader.execute_batch(&reader_id, &batch).await.expect_err("batch on a read-only connection");
    assert_eq!(count(&reader, &reader_id, "gt_ro").await, 1);

    reader.disconnect(&reader_id).await.expect("disconnect");
    run(&writer, &writer_id, "DROP TABLE gt_ro").await;
    writer.disconnect(&writer_id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_cancel_interrupts_a_running_query() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-cancel", false).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        flag.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    let mut sink = VecSink(Vec::new());
    let result = driver
        .query(&id, &request("SELECT SLEEP(10)", DEFAULT_CHUNK_ROWS, cancel), &mut sink)
        .await
        .expect("cancelled query");
    assert!(result.cancelled);
    assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    assert!(sink.0.last().is_some_and(|chunk| chunk.last));

    // The editor connection is usable again after the cancel.
    assert_eq!(run(&driver, &id, "SELECT 7").await[0][0], SqlValue::Int(7));
    assert_eq!(run(&driver, &id, "SELECT 8").await[0][0], SqlValue::Int(8));
    driver.disconnect(&id).await.expect("disconnect");
}

/// Sets the cancel flag once the first chunk arrives.
struct CancelAfterFirst {
    chunks: Vec<RowChunk>,
    cancel: Arc<AtomicBool>,
}

#[async_trait]
impl ChunkSink for CancelAfterFirst {
    async fn on_chunk(&mut self, chunk: RowChunk) -> Result<(), CoreError> {
        self.cancel.store(true, Ordering::Relaxed);
        self.chunks.push(chunk);
        Ok(())
    }
}

#[tokio::test]
async fn mysql_cancel_mid_stream_leaves_the_editor_usable() {
    let Some(target) = target() else {
        return;
    };
    let (driver, id) = open(&target, "mysql-cancel-stream", false).await;
    let digits = "(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
                   UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
                   UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
    let sql = format!(
        "SELECT a.n, b.n, c.n, d.n, REPEAT('x', 200) AS pad
         FROM {digits} a CROSS JOIN {digits} b CROSS JOIN {digits} c CROSS JOIN {digits} d"
    );
    for _ in 0..3 {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut sink = CancelAfterFirst { chunks: Vec::new(), cancel: Arc::clone(&cancel) };
        let result = driver.query(&id, &request(&sql, 50, cancel), &mut sink).await.expect("query");
        assert!(result.cancelled);
        assert!(result.row_count < 10_000);
        assert!(sink.chunks.last().is_some_and(|chunk| chunk.last));
        assert_eq!(run(&driver, &id, "SELECT 5").await[0][0], SqlValue::Int(5));
    }
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_check_parses_without_running() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "my-check", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gi_check").await;
    run(&driver, &id, "CREATE TABLE gi_check (id INT PRIMARY KEY, name TEXT)").await;
    assert!(driver.check(&id, "SELECT name FROM gi_check").await.expect("check").problem.is_none());
    let missing = driver.check(&id, "SELECT nope FROM gi_check").await.expect("check");
    assert_eq!(missing.problem.expect("problem").code.as_deref(), Some("1054"));
    assert!(driver.check(&id, "SELEC 1").await.expect("check").problem.is_some());
    driver.check(&id, "DELETE FROM gi_check").await.expect("check");
    run(&driver, &id, "INSERT INTO gi_check VALUES (1, 'a')").await;
    driver.check(&id, "DELETE FROM gi_check").await.expect("check");
    assert_eq!(run(&driver, &id, "SELECT count(*) FROM gi_check").await[0][0], SqlValue::Int(1));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_lists_foreign_keys() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "my-fk", false).await;
    for sql in [
        "DROP TABLE IF EXISTS gi_line",
        "DROP TABLE IF EXISTS gi_order",
        "DROP TABLE IF EXISTS gi_customer",
        "CREATE TABLE gi_customer (id INT PRIMARY KEY)",
        "CREATE TABLE gi_order (id INT, region VARCHAR(8), customer_id INT, PRIMARY KEY (region, id), CONSTRAINT gi_order_customer FOREIGN KEY (customer_id) REFERENCES gi_customer (id) ON DELETE CASCADE)",
        "CREATE TABLE gi_line (n INT, order_region VARCHAR(8), order_id INT, CONSTRAINT gi_line_order FOREIGN KEY (order_region, order_id) REFERENCES gi_order (region, id))",
    ] {
        run(&driver, &id, sql).await;
    }
    let keys = driver.foreign_keys(&id).await.expect("foreign keys");
    let order = keys.iter().find(|key| key.name == "gi_order_customer").expect("order fk");
    assert_eq!(order.columns, vec!["customer_id".to_owned()]);
    assert_eq!(order.ref_columns, vec!["id".to_owned()]);
    assert_eq!(order.on_delete, "CASCADE");
    let line = keys.iter().find(|key| key.name == "gi_line_order").expect("line fk");
    assert_eq!(line.columns, vec!["order_region".to_owned(), "order_id".to_owned()]);
    assert_eq!(line.ref_columns, vec!["region".to_owned(), "id".to_owned()]);
    driver.disconnect(&id).await.expect("disconnect");
}

/// (column, type, sample, how MySQL itself prints it: "num" → col+0, "text" → CAST AS CHAR, "hex" → HEX).
const MYSQL_TYPES: &[(&str, &str, &str, &str)] = &[
    ("c_tinyint", "TINYINT", "-128", "num"),
    ("c_utinyint", "TINYINT UNSIGNED", "255", "num"),
    ("c_smallint", "SMALLINT", "-32768", "num"),
    ("c_mediumint", "MEDIUMINT", "-8388608", "num"),
    ("c_int", "INT", "-2147483648", "num"),
    ("c_uint", "INT UNSIGNED", "4294967295", "num"),
    ("c_bigint", "BIGINT", "-9223372036854775808", "num"),
    ("c_ubigint", "BIGINT UNSIGNED", "18446744073709551615", "text"),
    ("c_bool", "BOOLEAN", "TRUE", "num"),
    ("c_bit", "BIT(10)", "b'1010101010'", "num"),
    ("c_decimal", "DECIMAL(30,10)", "12345678901234567890.0123456789", "text"),
    ("c_float", "FLOAT", "3.25", "num"),
    ("c_double", "DOUBLE", "-1.5e300", "num"),
    ("c_date", "DATE", "'2026-06-12'", "text"),
    ("c_datetime", "DATETIME(6)", "'2026-06-12 10:00:00.123456'", "text"),
    ("c_timestamp", "TIMESTAMP(3) NULL", "'2026-06-12 10:00:00.5'", "text"),
    ("c_time", "TIME(3)", "'-838:59:59.000'", "text"),
    ("c_time_long", "TIME", "'100:00:01'", "text"),
    ("c_year", "YEAR", "2026", "num"),
    ("c_char", "CHAR(5)", "'ab'", "text"),
    ("c_varchar", "VARCHAR(20)", "'héllo ✓'", "text"),
    ("c_binary", "BINARY(4)", "0xDEADBEEF", "hex"),
    ("c_varbinary", "VARBINARY(8)", "0xDEADBEEF00", "hex"),
    ("c_varbinary_text", "VARBINARY(8)", "'plain'", "text"),
    ("c_tinyblob", "TINYBLOB", "0xFF00FF", "hex"),
    ("c_blob", "BLOB", "0xCAFEBABE", "hex"),
    ("c_mediumblob", "MEDIUMBLOB", "0x00", "hex"),
    ("c_longblob", "LONGBLOB", "0xC3", "hex"),
    ("c_tinytext", "TINYTEXT", "'tiny'", "text"),
    ("c_text", "TEXT", "'línea 1\nlínea 2'", "text"),
    ("c_mediumtext", "MEDIUMTEXT", "'medium'", "text"),
    ("c_longtext", "LONGTEXT", "'long'", "text"),
    ("c_enum", "ENUM('ok','sad')", "'sad'", "text"),
    ("c_set", "SET('a','b','c')", "'a,c'", "text"),
    ("c_json", "JSON", "'{\"a\": [1, 2.5, null]}'", "text"),
    ("c_geometry", "GEOMETRY", "ST_GeomFromText('POINT(1 2)')", "hex"),
    ("c_point", "POINT", "ST_GeomFromText('POINT(1.5 -2)')", "hex"),
    ("c_linestring", "LINESTRING", "ST_GeomFromText('LINESTRING(0 0,1 1)')", "hex"),
    ("c_polygon", "POLYGON", "ST_GeomFromText('POLYGON((0 0,1 1,1 0,0 0))')", "hex"),
    ("c_multipoint", "MULTIPOINT", "ST_GeomFromText('MULTIPOINT((0 0),(1 1))')", "hex"),
    (
        "c_collection",
        "GEOMETRYCOLLECTION",
        "ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 1))')",
        "hex",
    ),
];

fn mysql_shown(value: &SqlValue) -> String {
    match value {
        SqlValue::Text(text) => text.clone(),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) => value.to_string(),
        SqlValue::Bool(value) => {
            if *value {
                "1".into()
            } else {
                "0".into()
            }
        }
        SqlValue::Bytes(bytes) => bytes.iter().map(|byte| format!("{byte:02X}")).collect(),
        SqlValue::Null => "NULL".into(),
    }
}

#[tokio::test]
async fn mysql_reads_and_writes_back_every_type() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mysql-types", false).await;
    let columns: Vec<String> =
        MYSQL_TYPES.iter().map(|(name, kind, _, _)| format!("{name} {kind}")).collect();
    let names: Vec<&str> = MYSQL_TYPES.iter().map(|(name, ..)| *name).collect();
    let samples: Vec<&str> = MYSQL_TYPES.iter().map(|(_, _, sample, _)| *sample).collect();
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_types").await;
    run(&driver, &id, &format!("CREATE TABLE gridl_types (id INT PRIMARY KEY, {}, c_zero_date DATE, c_zero_datetime DATETIME)", columns.join(", "))).await;
    run(
        &driver,
        &id,
        &format!(
            "INSERT INTO gridl_types (id, {}) VALUES (1, {})",
            names.join(", "),
            samples.join(", ")
        ),
    )
    .await;
    run(&driver, &id, "INSERT INTO gridl_types (id) VALUES (2)").await;
    // Zero dates exist in old data even though strict mode refuses new ones.
    run(&driver, &id, "SET SESSION sql_mode = ''").await;
    run(&driver, &id, "UPDATE gridl_types SET c_zero_date = '0000-00-00', c_zero_datetime = '0000-00-00 00:00:00' WHERE id = 1").await;

    let printed: Vec<String> = MYSQL_TYPES
        .iter()
        .map(|(name, _, _, how)| match *how {
            "num" => format!("CAST({name} + 0 AS CHAR)"),
            "hex" => format!("HEX({name})"),
            _ => format!("CAST({name} AS CHAR)"),
        })
        .collect();
    let expected =
        run(&driver, &id, &format!("SELECT {} FROM gridl_types WHERE id = 1", printed.join(", ")))
            .await;
    let select = format!(
        "SELECT {}, c_zero_date, c_zero_datetime FROM gridl_types ORDER BY id",
        names.join(", ")
    );
    let rows = run(&driver, &id, &select).await;

    let mut sink = VecSink(Vec::new());
    let with_params = QueryRequest::new(
        "query-params",
        format!(
            "SELECT {}, c_zero_date, c_zero_datetime FROM gridl_types WHERE id = ? ORDER BY id",
            names.join(", ")
        ),
        vec![SqlValue::Int(1)],
        DEFAULT_CHUNK_ROWS,
        MAX_STREAM_ROWS,
        Arc::new(AtomicBool::new(false)),
    )
    .expect("request");
    driver.query(&id, &with_params, &mut sink).await.expect("select with parameters");
    let binary: Vec<Vec<SqlValue>> = sink.0.into_iter().flat_map(|chunk| chunk.rows).collect();

    for (index, (name, kind, _, _)) in MYSQL_TYPES.iter().enumerate() {
        let SqlValue::Text(printed) = &expected[0][index] else {
            panic!("{name}: printed {:?}", expected[0][index])
        };
        let shown = mysql_shown(&rows[0][index]);
        let numeric = |text: &str| text.parse::<f64>().ok();
        let same =
            shown == *printed || (numeric(&shown).is_some() && numeric(&shown) == numeric(printed));
        assert!(same, "{name} ({kind}) reads {shown:?}, MySQL prints {printed:?}");
        assert_eq!(binary[0][index], rows[0][index], "{name} ({kind}) is the same with parameters");
        assert_eq!(rows[1][index], SqlValue::Null, "{name} ({kind}) NULL");
    }
    let zero = names.len();
    assert_eq!(rows[0][zero], SqlValue::Text("0000-00-00".into()));
    assert_eq!(rows[0][zero + 1], SqlValue::Text("0000-00-00 00:00:00".into()));
    assert_eq!(binary[0][zero], rows[0][zero], "zero date with parameters");
    assert_eq!(binary[0][zero + 1], rows[0][zero + 1], "zero datetime with parameters");

    // Saving a cell sends back what the grid shows, as the app does.
    for (index, (name, kind, _, _)) in MYSQL_TYPES.iter().enumerate() {
        let sql = format!("UPDATE gridl_types SET {name} = ? WHERE id = 1");
        let batch = BatchRequest::new(vec![BatchStatement {
            sql: sql.clone(),
            params: vec![rows[0][index].clone()],
        }])
        .expect("batch");
        driver
            .execute_batch(&id, &batch)
            .await
            .unwrap_or_else(|err| panic!("{name} ({kind}): {err}"));
    }
    let again = run(&driver, &id, &select).await;
    for (index, (name, kind, _, _)) in MYSQL_TYPES.iter().enumerate() {
        assert_eq!(
            again[0][index], rows[0][index],
            "{name} ({kind}) is unchanged after saving it back"
        );
    }
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_explain_comes_back_as_json_text() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "my-explain", false).await;
    let rows = run(
        &driver,
        &id,
        "EXPLAIN FORMAT=JSON SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_ROWS > 1",
    )
    .await;
    let SqlValue::Text(text) = rows[0][0].clone() else {
        panic!("plan is not text: {:?}", rows[0][0])
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("plan json");
    assert!(parsed["query_block"].is_object(), "{text}");
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mysql_text_parameters_match_numeric_columns() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "my-params", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_params").await;
    run(&driver, &id, "CREATE TABLE gridl_params (id INT PRIMARY KEY, name TEXT, at DATE)").await;
    run(
        &driver,
        &id,
        "INSERT INTO gridl_params VALUES (5, 'five', '2024-01-02'), (6, 'six', '2024-03-04')",
    )
    .await;
    let request = QueryRequest::new(
        "query-1",
        "SELECT name FROM gridl_params WHERE (id = ? OR id = ? + 1) AND at >= ? AND name <> ? ORDER BY id",
        vec![SqlValue::Text("5".into()), SqlValue::Text("5".into()), SqlValue::Text("2024-02-01".into()), SqlValue::Text("it's".into())],
        DEFAULT_CHUNK_ROWS,
        MAX_STREAM_ROWS,
        Arc::new(AtomicBool::new(false)),
    )
    .expect("request");
    let mut sink = VecSink(Vec::new());
    driver.query(&id, &request, &mut sink).await.expect("query");
    let rows: Vec<_> = sink.0.into_iter().flat_map(|chunk| chunk.rows).collect();
    assert_eq!(rows, vec![vec![SqlValue::Text("six".into())]]);
    run(&driver, &id, "DROP TABLE gridl_params").await;
    driver.disconnect(&id).await.expect("disconnect");
}

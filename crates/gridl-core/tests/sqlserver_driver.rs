//! Runs against a live SQL Server named by `GRIDL_TEST_MSSQL`, formatted as
//! `user:password@host:port/database`. The database is created when missing.
//! Every test returns early when the variable is unset, so CI passes without a server.
//!
//! ```text
//! docker run -d --rm --name gridl-mssql-test -e ACCEPT_EULA=Y \
//!   -e MSSQL_SA_PASSWORD=Gridl_Test1 -p 11433:1433 mcr.microsoft.com/mssql/server:2022-latest
//! GRIDL_TEST_MSSQL=sa:Gridl_Test1@127.0.0.1:11433/gridl cargo test -p gridl-core --test sqlserver_driver
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError,
    DatabaseDriver, DatabaseEngine, QueryRequest, QueryResult, RelationKind, RelationRef, RowChunk,
    SecretString, SqlValue, SqlserverDriver, TableSchema, DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
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
    let raw = std::env::var("GRIDL_TEST_MSSQL").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (credentials, location) = raw.rsplit_once('@').expect("user:password@host:port/db");
    let (user, password) = credentials.split_once(':').unwrap_or((credentials, ""));
    let (address, database) = location.split_once('/').expect("missing /database");
    let (host, port) = address.rsplit_once(':').unwrap_or((address, "1433"));
    Some(Target {
        host: host.to_owned(),
        port: port.parse().expect("port"),
        user: user.to_owned(),
        password: password.to_owned(),
        database: database.to_owned(),
    })
}

fn config(target: &Target, id: &str, database: &str, read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        id: id.into(),
        name: "SQL Server test".into(),
        engine: DatabaseEngine::Sqlserver,
        database: database.to_owned(),
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

static DATABASE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// Creates the test database through `master` the first time a test needs it.
async fn ensure_database(target: &Target) {
    DATABASE
        .get_or_init(|| async {
            let driver = SqlserverDriver::new();
            let master = config(target, "mssql-master", "master", false);
            let password = SecretString::new(target.password.clone());
            driver.connect(&master, Some(&password), None).await.expect("connect to master");
            let id = master.connection_id().expect("id");
            let name = target.database.replace(']', "]]");
            run(&driver, &id, &format!("IF DB_ID(N'{name}') IS NULL CREATE DATABASE [{name}]"))
                .await;
            driver.disconnect(&id).await.expect("disconnect");
        })
        .await;
}

async fn open(target: &Target, id: &str, read_only: bool) -> (SqlserverDriver, ConnectionId) {
    ensure_database(target).await;
    let driver = SqlserverDriver::new();
    let connection = config(target, id, &target.database, read_only);
    let password = SecretString::new(target.password.clone());
    driver.connect(&connection, Some(&password), None).await.expect("connect");
    (driver, connection.connection_id().expect("id"))
}

fn request(sql: &str, chunk_rows: usize, cancel: Arc<AtomicBool>) -> QueryRequest {
    QueryRequest::new("query-1", sql, Vec::new(), chunk_rows, MAX_STREAM_ROWS, cancel)
        .expect("request")
}

async fn try_run(
    driver: &SqlserverDriver,
    id: &ConnectionId,
    sql: &str,
) -> Result<(QueryResult, Vec<RowChunk>), CoreError> {
    let mut sink = VecSink(Vec::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let result = driver.query(id, &request(sql, DEFAULT_CHUNK_ROWS, cancel), &mut sink).await?;
    Ok((result, sink.0))
}

async fn run(driver: &SqlserverDriver, id: &ConnectionId, sql: &str) -> Vec<Vec<SqlValue>> {
    let (_, chunks) = try_run(driver, id, sql).await.unwrap_or_else(|err| panic!("{sql}: {err}"));
    chunks.into_iter().flat_map(|chunk| chunk.rows).collect()
}

async fn count(driver: &SqlserverDriver, id: &ConnectionId, table: &str) -> i64 {
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

/// 0..10_000 as a derived table `d(n)`.
const NUMBERS: &str = "(SELECT a.n * 1000 + b.n * 100 + c.n * 10 + e.n AS n
     FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) a(n)
     CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) b(n)
     CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) c(n)
     CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) e(n)) d";

#[tokio::test]
async fn mssql_introspects_schemas_keys_and_routines() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-introspect", false).await;
    for sql in [
        "DROP VIEW IF EXISTS gi.active_people",
        "DROP PROCEDURE IF EXISTS gi.rename_person",
        "DROP FUNCTION IF EXISTS gi.full_name",
        "DROP FUNCTION IF EXISTS gi.people_named",
        "DROP TABLE IF EXISTS gi.person",
        "IF SCHEMA_ID('gi') IS NULL EXEC('CREATE SCHEMA gi')",
        "CREATE TABLE gi.person (
            id int IDENTITY PRIMARY KEY,
            name nvarchar(50) NOT NULL,
            nick varchar(max) NULL,
            score decimal(10,2) NOT NULL DEFAULT 0,
            born datetime2(3) NULL,
            active bit NOT NULL CONSTRAINT df_active DEFAULT 1,
            label AS (name + N'!')
        )",
        "CREATE UNIQUE INDEX person_name ON gi.person (name DESC) INCLUDE (score) WHERE active = 1",
        "CREATE VIEW gi.active_people AS SELECT id, name FROM gi.person WHERE active = 1",
        "CREATE PROCEDURE gi.rename_person @id int, @name nvarchar(50), @old nvarchar(50) OUTPUT AS
         BEGIN SELECT @old = name FROM gi.person WHERE id = @id; UPDATE gi.person SET name = @name WHERE id = @id; END",
        "CREATE FUNCTION gi.full_name (@id int) RETURNS nvarchar(60) AS
         BEGIN RETURN (SELECT name FROM gi.person WHERE id = @id) END",
        "CREATE FUNCTION gi.people_named (@name nvarchar(50)) RETURNS TABLE AS
         RETURN SELECT id FROM gi.person WHERE name = @name",
    ] {
        run(&driver, &id, sql).await;
    }

    let relations = driver.list_relations(&id).await.expect("relations");
    assert!(relations.iter().any(|relation| relation.schema.as_deref() == Some("gi")
        && relation.name == "person"
        && relation.kind == RelationKind::Table));

    let schema = driver.introspect(&id).await.expect("introspect");
    let person = find(&schema, "person", RelationKind::Table);
    assert_eq!(person.schema.as_deref(), Some("gi"));
    let column = |name: &str| {
        person.columns.iter().find(|column| column.name == name).unwrap_or_else(|| panic!("{name}"))
    };
    assert!(column("id").primary_key);
    assert_eq!(column("id").default_value.as_deref(), Some("identity"));
    assert_eq!(column("name").data_type, "nvarchar(50)");
    assert!(!column("name").nullable);
    assert_eq!(column("nick").data_type, "varchar(max)");
    assert_eq!(column("score").data_type, "decimal(10,2)");
    assert_eq!(column("score").default_value.as_deref(), Some("0"));
    assert_eq!(column("born").data_type, "datetime2(3)");
    assert_eq!(column("active").default_value.as_deref(), Some("1"));
    assert_eq!(column("label").default_value.as_deref(), Some("computed"));

    let view = find(&schema, "active_people", RelationKind::View);
    assert!(view.definition.as_deref().is_some_and(|body| body.contains("CREATE VIEW")));
    assert_eq!(view.columns.len(), 2);

    let procedure = find(&schema, "rename_person", RelationKind::Procedure);
    let modes: Vec<_> =
        procedure.columns.iter().map(|arg| (arg.name.as_str(), arg.mode.as_deref())).collect();
    assert_eq!(modes, vec![("@id", Some("IN")), ("@name", Some("IN")), ("@old", Some("INOUT"))]);
    let scalar = find(&schema, "full_name", RelationKind::Function);
    assert_eq!(scalar.returns.as_deref(), Some("nvarchar(60)"));
    assert_eq!(scalar.columns.len(), 1);
    let table_valued = find(&schema, "people_named", RelationKind::Function);
    assert_eq!(table_valued.returns.as_deref(), Some("TABLE"));

    let index = find(&schema, "person.person_name", RelationKind::Index);
    assert_eq!(
        index.definition.as_deref(),
        Some("CREATE UNIQUE NONCLUSTERED INDEX \"person_name\" ON \"gi\".\"person\" (\"name\" DESC) INCLUDE (\"score\") WHERE ([active]=(1))")
    );
    assert!(schema.iter().any(|table| table.kind == RelationKind::Index
        && table.definition.as_deref().is_some_and(|sql| sql.contains("PRIMARY KEY CLUSTERED"))));

    let described = driver
        .describe_relation(
            &id,
            &RelationRef {
                schema: Some("gi".into()),
                name: "person".into(),
                kind: RelationKind::Table,
            },
        )
        .await
        .expect("describe");
    assert_eq!(described.columns, person.columns);
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_streams_chunks() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-stream", false).await;
    let mut sink = VecSink(Vec::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let sql =
        format!("SELECT n, CONCAT(N'row ', n) AS label FROM {NUMBERS} WHERE n < 1000 ORDER BY n");
    let result = driver.query(&id, &request(&sql, 128, cancel), &mut sink).await.expect("query");
    assert_eq!(result.row_count, 1000);
    assert!(!result.cancelled && !result.truncated);
    let chunks = sink.0;
    assert_eq!(chunks.len(), 8);
    assert_eq!(chunks[0].columns[0].name, "n");
    assert_eq!(chunks[0].columns[1].data_type, "nvarchar");
    assert!(chunks[1..].iter().all(|chunk| chunk.columns.is_empty()));
    assert!(chunks[7].last);
    assert_eq!(chunks[7].rows.last().unwrap()[1], SqlValue::Text("row 999".into()));

    // An empty result still carries its header.
    let (result, chunks) =
        try_run(&driver, &id, "SELECT 1 AS one WHERE 1 = 0").await.expect("empty");
    assert_eq!(result.row_count, 0);
    assert_eq!(chunks[0].columns[0].name, "one");
    assert!(chunks[0].last);

    // GO splits batches; the first result is shown and later batches still run.
    let rows = run(
        &driver,
        &id,
        "CREATE TABLE #go_test (n int)\nGO\nINSERT INTO #go_test VALUES (1), (2)\ngo\nSELECT COUNT(*) FROM #go_test\nGO\nSELECT 99",
    )
    .await;
    assert_eq!(rows, vec![vec![SqlValue::Int(2)]]);

    // An error after the shown result still fails the query.
    let err = try_run(&driver, &id, "SELECT 1; SELECT 1/0").await.expect_err("divide by zero");
    assert!(err.to_string().contains("ivide by zero"), "{err}");
    assert_eq!(run(&driver, &id, "SELECT 3").await[0][0], SqlValue::Int(3));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_editor_transactions_span_queries() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-tx", false).await;
    let (observer, observer_id) = open(&target, "mssql-tx-observer", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gt_tx").await;
    run(&driver, &id, "CREATE TABLE gt_tx (id int PRIMARY KEY)").await;

    run(&driver, &id, "BEGIN TRANSACTION").await;
    let (result, _) = try_run(&driver, &id, "INSERT INTO gt_tx VALUES (1), (2)").await.unwrap();
    assert_eq!(result.rows_affected, 2);
    let (result, _) = try_run(&driver, &id, "UPDATE gt_tx SET id = id + 10").await.unwrap();
    assert_eq!(result.rows_affected, 2);
    assert_eq!(count(&driver, &id, "gt_tx").await, 2);
    assert_eq!(count(&observer, &observer_id, "gt_tx WITH (READPAST)").await, 0);
    run(&driver, &id, "ROLLBACK").await;
    assert_eq!(count(&driver, &id, "gt_tx").await, 0);

    // Temporary tables and variables set by one run are there for the next.
    run(&driver, &id, "SELECT 41 AS n INTO #marker").await;
    assert_eq!(run(&driver, &id, "SELECT n + 1 FROM #marker").await[0][0], SqlValue::Int(42));

    run(&driver, &id, "DROP TABLE gt_tx").await;
    observer.disconnect(&observer_id).await.expect("disconnect");
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_batch_rolls_back_on_failure() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-batch", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gt_batch").await;
    run(&driver, &id, "CREATE TABLE gt_batch (id int PRIMARY KEY, label nvarchar(max))").await;

    let insert = |id: i64| BatchStatement {
        sql: "INSERT INTO gt_batch (id, label) VALUES (?, ?)".into(),
        params: vec![SqlValue::Int(id), SqlValue::Text(format!("label {id} ✓"))],
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
        vec![vec![SqlValue::Text("label 1 ✓".into())], vec![SqlValue::Null]]
    );
    run(&driver, &id, "DROP TABLE gt_batch").await;
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_read_only_connection_rejects_writes() {
    let Some(target) = target() else { return };
    let (writer, writer_id) = open(&target, "mssql-ro-writer", false).await;
    run(&writer, &writer_id, "DROP TABLE IF EXISTS gt_ro").await;
    run(&writer, &writer_id, "CREATE TABLE gt_ro (id int PRIMARY KEY)").await;
    run(&writer, &writer_id, "INSERT INTO gt_ro VALUES (1)").await;

    let (reader, reader_id) = open(&target, "mssql-ro-reader", true).await;
    assert_eq!(count(&reader, &reader_id, "gt_ro").await, 1);
    for sql in [
        "INSERT INTO gt_ro VALUES (2)",
        "SELECT 1\nDELETE FROM gt_ro",
        "SELECT * INTO gt_ro2 FROM gt_ro",
    ] {
        let err = try_run(&reader, &reader_id, sql).await.expect_err(sql);
        assert!(err.to_string().contains("read-only"), "{err}");
    }
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
async fn mssql_cancel_interrupts_a_running_query() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-cancel", false).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        flag.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    let mut sink = VecSink(Vec::new());
    let result = driver
        .query(
            &id,
            &request("WAITFOR DELAY '00:00:10'; SELECT 1", DEFAULT_CHUNK_ROWS, cancel),
            &mut sink,
        )
        .await
        .expect("cancelled query");
    assert!(result.cancelled);
    assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    assert!(sink.0.last().is_some_and(|chunk| chunk.last));
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
async fn mssql_cancel_mid_stream_and_row_limit_leave_the_editor_usable() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-cancel-stream", false).await;
    let sql = format!("SELECT n, REPLICATE('x', 200) AS pad FROM {NUMBERS}");
    for _ in 0..3 {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut sink = CancelAfterFirst { chunks: Vec::new(), cancel: Arc::clone(&cancel) };
        let result = driver.query(&id, &request(&sql, 50, cancel), &mut sink).await.expect("query");
        assert!(result.cancelled);
        assert!(result.row_count < 10_000);
        assert!(sink.chunks.last().is_some_and(|chunk| chunk.last));
        assert_eq!(run(&driver, &id, "SELECT 5").await[0][0], SqlValue::Int(5));
    }
    let limited =
        QueryRequest::new("limited", sql, Vec::new(), 100, 250, Arc::new(AtomicBool::new(false)))
            .expect("request");
    let mut sink = VecSink(Vec::new());
    let result = driver.query(&id, &limited, &mut sink).await.expect("limited");
    assert!(result.truncated);
    assert_eq!(result.row_count, 250);
    assert_eq!(run(&driver, &id, "SELECT 6").await[0][0], SqlValue::Int(6));
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_check_parses_without_running() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-check", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gi_check").await;
    run(&driver, &id, "CREATE TABLE gi_check (id int PRIMARY KEY, name nvarchar(20))").await;
    assert!(driver.check(&id, "SELECT name FROM gi_check").await.expect("check").problem.is_none());
    let missing = driver.check(&id, "SELECT nope FROM gi_check").await.expect("check");
    assert_eq!(missing.problem.expect("problem").code.as_deref(), Some("207"));
    // Syntax errors point at their line.
    let syntax = driver.check(&id, "SELECT name\nFROM gi_check\nWHER id = 1").await.expect("check");
    assert_eq!(syntax.problem.expect("problem").position, Some(27));
    assert!(driver.check(&id, "SELECT * FROM WHERE").await.expect("check").problem.is_some());
    run(&driver, &id, "INSERT INTO gi_check VALUES (1, 'a')").await;
    driver.check(&id, "DELETE FROM gi_check").await.expect("check");
    assert_eq!(count(&driver, &id, "gi_check").await, 1);
    // The pooled connection is back to executing statements.
    let batch = BatchRequest::new(vec![BatchStatement {
        sql: "INSERT INTO gi_check VALUES (2, 'b')".into(),
        params: Vec::new(),
    }])
    .expect("batch");
    driver.execute_batch(&id, &batch).await.expect("batch");
    assert_eq!(count(&driver, &id, "gi_check").await, 2);
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_lists_foreign_keys() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-fk", false).await;
    for sql in [
        "DROP TABLE IF EXISTS gi_line",
        "DROP TABLE IF EXISTS gi_order",
        "DROP TABLE IF EXISTS gi_customer",
        "CREATE TABLE gi_customer (id int PRIMARY KEY)",
        "CREATE TABLE gi_order (id int, region varchar(8), customer_id int, PRIMARY KEY (region, id), CONSTRAINT gi_order_customer FOREIGN KEY (customer_id) REFERENCES gi_customer (id) ON DELETE CASCADE)",
        "CREATE TABLE gi_line (n int, order_region varchar(8), order_id int, CONSTRAINT gi_line_order FOREIGN KEY (order_region, order_id) REFERENCES gi_order (region, id))",
    ] {
        run(&driver, &id, sql).await;
    }
    let keys = driver.foreign_keys(&id).await.expect("foreign keys");
    let order = keys.iter().find(|key| key.name == "gi_order_customer").expect("order fk");
    assert_eq!(order.schema.as_deref(), Some("dbo"));
    assert_eq!(order.columns, vec!["customer_id".to_owned()]);
    assert_eq!(order.on_delete, "CASCADE");
    assert_eq!(order.on_update, "NO ACTION");
    let line = keys.iter().find(|key| key.name == "gi_line_order").expect("line fk");
    assert_eq!(line.columns, vec!["order_region".to_owned(), "order_id".to_owned()]);
    assert_eq!(line.ref_columns, vec!["region".to_owned(), "id".to_owned()]);
    for table in ["gi_line", "gi_order", "gi_customer"] {
        run(&driver, &id, &format!("DROP TABLE {table}")).await;
    }
    driver.disconnect(&id).await.expect("disconnect");
}

/// (column, type, sample literal, the text SQL Server prints for it with CONVERT style 126 / 2).
const MSSQL_TYPES: &[(&str, &str, &str)] = &[
    ("c_bit", "bit", "1"),
    ("c_tinyint", "tinyint", "255"),
    ("c_smallint", "smallint", "-32768"),
    ("c_int", "int", "-2147483648"),
    ("c_bigint", "bigint", "-9223372036854775808"),
    ("c_decimal", "decimal(30,10)", "12345678901234567890.0123456789"),
    ("c_numeric", "numeric(5,2)", "-1.50"),
    ("c_money", "money", "12.3456"),
    ("c_smallmoney", "smallmoney", "-3.25"),
    ("c_real", "real", "3.25"),
    ("c_float", "float", "-1.5e300"),
    ("c_date", "date", "'2026-06-12'"),
    ("c_time", "time(3)", "'10:00:00.123'"),
    ("c_datetime", "datetime", "'2026-06-12T10:00:00.500'"),
    ("c_smalldatetime", "smalldatetime", "'2026-06-12T10:01:00'"),
    ("c_datetime2", "datetime2", "'2026-06-12T10:00:00.1234567'"),
    ("c_datetimeoffset", "datetimeoffset(3)", "'2026-06-12T10:00:00.250+02:00'"),
    ("c_char", "char(5)", "'ab'"),
    ("c_varchar", "varchar(20)", "'plain'"),
    ("c_varchar_max", "varchar(max)", "'long'"),
    ("c_nchar", "nchar(3)", "N'ñ'"),
    ("c_nvarchar", "nvarchar(20)", "N'héllo ✓'"),
    ("c_nvarchar_max", "nvarchar(max)", "N'línea 1\nlínea 2'"),
    ("c_text", "text", "'old text'"),
    ("c_ntext", "ntext", "N'old ñ'"),
    ("c_binary", "binary(4)", "0xDEADBEEF"),
    ("c_varbinary", "varbinary(8)", "0xDEADBEEF00"),
    ("c_varbinary_max", "varbinary(max)", "0xCAFEBABE"),
    ("c_image", "image", "0xC3"),
    ("c_uuid", "uniqueidentifier", "'6F9619FF-8B86-D011-B42D-00C04FC964FF'"),
    ("c_xml", "xml", "'<a b=\"1\">x</a>'"),
];

/// Reads like the grid shows it, compared with how SQL Server converts the value to text.
fn shown(value: &SqlValue) -> String {
    match value {
        SqlValue::Text(text) => text.clone(),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) => value.to_string(),
        SqlValue::Bool(value) => u8::from(*value).to_string(),
        SqlValue::Bytes(bytes) => {
            format!("0x{}", bytes.iter().map(|byte| format!("{byte:02X}")).collect::<String>())
        }
        SqlValue::Null => "NULL".into(),
    }
}

#[tokio::test]
async fn mssql_reads_and_writes_back_every_type() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-types", false).await;
    let columns: Vec<String> =
        MSSQL_TYPES.iter().map(|(name, kind, _)| format!("{name} {kind} NULL")).collect();
    let names: Vec<&str> = MSSQL_TYPES.iter().map(|(name, ..)| *name).collect();
    let samples: Vec<&str> = MSSQL_TYPES.iter().map(|(_, _, sample)| *sample).collect();
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_types").await;
    run(
        &driver,
        &id,
        &format!("CREATE TABLE gridl_types (id int PRIMARY KEY, {})", columns.join(", ")),
    )
    .await;
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

    // How SQL Server itself prints each value.
    let printed: Vec<String> = MSSQL_TYPES
        .iter()
        .map(|(name, kind, _)| match *kind {
            "binary(4)" | "varbinary(8)" | "varbinary(max)" => {
                format!("CONVERT(varchar(max), {name}, 1)")
            }
            "image" => format!("CONVERT(varchar(max), CAST({name} AS varbinary(max)), 1)"),
            "float" | "real" => format!("CONVERT(varchar(64), {name}, 3)"),
            "money" | "smallmoney" => format!("CONVERT(varchar(64), {name}, 2)"),
            "datetime" | "smalldatetime" | "datetime2" | "datetimeoffset(3)" | "time(3)"
            | "date" => {
                format!("CONVERT(nvarchar(64), {name}, 121)")
            }
            "text" | "ntext" | "xml" => format!("CAST({name} AS nvarchar(max))"),
            _ => format!("CAST({name} AS nvarchar(max))"),
        })
        .collect();
    let expected =
        run(&driver, &id, &format!("SELECT {} FROM gridl_types WHERE id = 1", printed.join(", ")))
            .await;
    let select = format!("SELECT {} FROM gridl_types ORDER BY id", names.join(", "));
    let rows = run(&driver, &id, &select).await;

    let mut sink = VecSink(Vec::new());
    let with_params = QueryRequest::new(
        "query-params",
        format!("SELECT {} FROM gridl_types WHERE id = ? ORDER BY id", names.join(", ")),
        vec![SqlValue::Text("1".into())],
        DEFAULT_CHUNK_ROWS,
        MAX_STREAM_ROWS,
        Arc::new(AtomicBool::new(false)),
    )
    .expect("request");
    driver.query(&id, &with_params, &mut sink).await.expect("select with parameters");
    let bound: Vec<Vec<SqlValue>> = sink.0.into_iter().flat_map(|chunk| chunk.rows).collect();

    let numeric = |text: &str| text.parse::<f64>().ok();
    // Fractional seconds are compared without trailing zeros (.500 vs .5).
    let trimmed = |text: &str| {
        let (head, zone) = match text.rsplit_once(' ') {
            Some((head, zone)) if zone.starts_with('+') || zone.starts_with('-') => {
                (head, Some(zone))
            }
            _ => (text, None),
        };
        let head = if head.contains('.') {
            head.trim_end_matches('0').trim_end_matches('.')
        } else {
            head
        };
        match zone {
            Some(zone) => format!("{head} {zone}"),
            None => head.to_owned(),
        }
    };
    for (index, (name, kind, _)) in MSSQL_TYPES.iter().enumerate() {
        let SqlValue::Text(printed) = &expected[0][index] else {
            panic!("{name}: printed {:?}", expected[0][index])
        };
        let value = shown(&rows[0][index]);
        let same = value == *printed
            || trimmed(&value) == trimmed(printed)
            || value.trim_end() == printed.trim_end()
            || (numeric(&value).is_some() && numeric(&value) == numeric(printed));
        assert!(same, "{name} ({kind}) reads {value:?}, SQL Server prints {printed:?}");
        assert_eq!(bound[0][index], rows[0][index], "{name} ({kind}) is the same with parameters");
        assert_eq!(rows[1][index], SqlValue::Null, "{name} ({kind}) NULL");
    }

    // Saving a cell sends back what the grid shows, as the app does.
    for (index, (name, kind, _)) in MSSQL_TYPES.iter().enumerate() {
        let batch = BatchRequest::new(vec![BatchStatement {
            sql: format!("UPDATE gridl_types SET {name} = ? WHERE id = ?"),
            params: vec![rows[0][index].clone(), SqlValue::Text("1".into())],
        }])
        .expect("batch");
        driver
            .execute_batch(&id, &batch)
            .await
            .unwrap_or_else(|err| panic!("{name} ({kind}): {err}"));
    }
    let again = run(&driver, &id, &select).await;
    for (index, (name, kind, _)) in MSSQL_TYPES.iter().enumerate() {
        assert_eq!(
            again[0][index], rows[0][index],
            "{name} ({kind}) is unchanged after saving it back"
        );
    }
    run(&driver, &id, "DROP TABLE gridl_types").await;
    driver.disconnect(&id).await.expect("disconnect");
}

#[tokio::test]
async fn mssql_text_parameters_match_numeric_columns() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-params", false).await;
    run(&driver, &id, "DROP TABLE IF EXISTS gridl_params").await;
    run(&driver, &id, "CREATE TABLE gridl_params (id int PRIMARY KEY, name nvarchar(20), at date, amount decimal(10,2))").await;
    run(
        &driver,
        &id,
        "INSERT INTO gridl_params VALUES (5, N'five', '2024-01-02', 12.50), (6, N'six', '2024-03-04', 3)",
    )
    .await;
    let request = QueryRequest::new(
        "query-1",
        "SELECT name FROM gridl_params WHERE (id = ? OR id = ? + 1) AND at >= ? AND name <> ? AND amount < ? ORDER BY id",
        vec![
            SqlValue::Text("5".into()),
            SqlValue::Text("5".into()),
            SqlValue::Text("2024-02-01".into()),
            SqlValue::Text("it's".into()),
            SqlValue::Text("12.50".into()),
        ],
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

#[tokio::test]
async fn mssql_reads_one_tables_indexes_and_triggers() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "mssql-table-objects", false).await;
    for sql in [
        "DROP TABLE IF EXISTS gt_item",
        "DROP TABLE IF EXISTS gt_other",
        "CREATE TABLE gt_item (id int CONSTRAINT gt_item_pk PRIMARY KEY, name nvarchar(20))",
        "CREATE TABLE gt_other (id int PRIMARY KEY)",
        "CREATE INDEX gt_item_name ON gt_item (name)",
        "CREATE TRIGGER gt_item_touch ON gt_item AFTER UPDATE AS SELECT 1",
    ] {
        run(&driver, &id, sql).await;
    }
    let item = RelationRef {
        schema: Some("dbo".into()),
        name: "gt_item".into(),
        kind: RelationKind::Table,
    };
    let objects = driver.table_objects(&id, &item).await.expect("objects");
    let mut names: Vec<_> = objects.iter().map(|object| object.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["gt_item.gt_item_name", "gt_item.gt_item_pk", "gt_item_touch"]);
    assert!(objects.iter().all(|object| object.parent.as_deref() == Some("gt_item")));
    run(&driver, &id, "DROP TABLE gt_item").await;
    run(&driver, &id, "DROP TABLE gt_other").await;
    driver.disconnect(&id).await.expect("disconnect");
}

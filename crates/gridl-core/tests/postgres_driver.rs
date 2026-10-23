//! Runs against a live server when `GRIDL_TEST_PG` is set, for example
//! `GRIDL_TEST_PG=postgres:gridl@127.0.0.1:35432/gridl`. Skipped otherwise.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gridl_core::{
    BatchRequest, BatchStatement, ChunkSink, ConnectionConfig, ConnectionId, CoreError,
    DatabaseDriver, DatabaseEngine, PostgresDriver, QueryRequest, RelationKind, RelationRef,
    RowChunk, SecretString, SqlValue, TlsMode, DEFAULT_CHUNK_ROWS, MAX_STREAM_ROWS,
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

/// Every built-in type plus common extension types, one column each.
const ALL_TYPES: &[(&str, &str, &str)] = &[
    // (column, type, a sample literal)
    ("c_int2", "smallint", "-32768"),
    ("c_int4", "integer", "2147483647"),
    ("c_int8", "bigint", "-9223372036854775808"),
    ("c_numeric", "numeric", "123456789012345678901234567890.123456789"),
    ("c_numeric_scaled", "numeric(12,2)", "1234.5"),
    ("c_numeric_nan", "numeric", "'NaN'"),
    ("c_real", "real", "3.25"),
    ("c_double", "double precision", "'-Infinity'"),
    ("c_money", "money", "12.34"),
    ("c_text", "text", "'héllo ✓'"),
    ("c_varchar", "varchar(20)", "'short'"),
    ("c_char", "char(5)", "'ab'"),
    ("c_qchar", "\"char\"", "'x'"),
    ("c_name", "name", "'pg_name'"),
    ("c_bytea", "bytea", "'\\xdeadbeef'"),
    ("c_bool", "boolean", "true"),
    ("c_date", "date", "'2026-06-12'"),
    ("c_date_inf", "date", "'infinity'"),
    ("c_date_bc", "date", "'0044-03-15 BC'"),
    ("c_time", "time", "'13:45:07.25'"),
    ("c_time3", "time(3)", "'23:59:59.999'"),
    ("c_timetz", "timetz", "'08:00:00+05:30'"),
    ("c_timestamp", "timestamp", "'2026-06-12 10:00:00.123456'"),
    ("c_timestamp_inf", "timestamp", "'-infinity'"),
    ("c_timestamptz", "timestamptz", "'2026-06-12 10:00:00+02'"),
    ("c_interval", "interval", "'1 year 2 mons 3 days 04:05:06.5'"),
    ("c_point", "point", "'(1.5,2)'"),
    ("c_line", "line", "'{1,2,3}'"),
    ("c_lseg", "lseg", "'[(0,0),(1,1)]'"),
    ("c_box", "box", "'(1,1),(0,0)'"),
    ("c_path", "path", "'[(0,0),(1,1),(2,0)]'"),
    ("c_polygon", "polygon", "'((0,0),(1,1),(2,0))'"),
    ("c_circle", "circle", "'<(1,1),5>'"),
    ("c_cidr", "cidr", "'10.0.0.0/8'"),
    ("c_inet", "inet", "'192.168.0.1'"),
    ("c_inet6", "inet", "'::1/64'"),
    ("c_macaddr", "macaddr", "'08:00:2b:01:02:03'"),
    ("c_macaddr8", "macaddr8", "'08:00:2b:01:02:03:04:05'"),
    ("c_bit", "bit(4)", "B'1010'"),
    ("c_varbit", "bit varying(8)", "B'101'"),
    ("c_tsvector", "tsvector", "'a fat cat'"),
    ("c_tsquery", "tsquery", "'fat & (rat | cat)'"),
    ("c_uuid", "uuid", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'"),
    ("c_xml", "xml", "'<a>1</a>'"),
    ("c_json", "json", "'{\"a\": [1, 2]}'"),
    ("c_jsonb", "jsonb", "'{\"b\": {\"c\": null}}'"),
    ("c_jsonpath", "jsonpath", "'$.a[*] ? (@ > 1)'"),
    ("c_int4range", "int4range", "'[1,10)'"),
    ("c_int8range", "int8range", "'empty'"),
    ("c_numrange", "numrange", "'(1.5,2.5]'"),
    ("c_tsrange", "tsrange", "'[2026-01-01,2026-02-01)'"),
    ("c_tstzrange", "tstzrange", "'[2026-01-01 00:00+00,)'"),
    ("c_daterange", "daterange", "'[2026-01-01,2026-01-31]'"),
    ("c_multirange", "int4multirange", "'{[1,3), [5,8)}'"),
    ("c_pg_lsn", "pg_lsn", "'16/B374D848'"),
    ("c_snapshot", "pg_snapshot", "'10:20:10,14,15'"),
    ("c_txid_snapshot", "txid_snapshot", "'10:20:10,14,15'"),
    ("c_oid", "oid", "4294967295"),
    ("c_regclass", "regclass", "'pg_class'"),
    ("c_regtype", "regtype", "'integer'"),
    ("c_regproc", "regproc", "'now'"),
    ("c_xid", "xid", "'42'"),
    ("c_xid8", "xid8", "'42'"),
    ("c_cid", "cid", "'7'"),
    ("c_tid", "tid", "'(0,1)'"),
    ("c_int2vector", "int2vector", "'1 2 3'"),
    ("c_oidvector", "oidvector", "'23 25'"),
    ("c_aclitem", "aclitem", "'postgres=arwdDxtm/postgres'"),
    ("c_int_array", "integer[]", "'{1,NULL,3}'"),
    ("c_text_array", "text[]", "'{\"a b\",\"c,d\",NULL}'"),
    ("c_matrix", "integer[][]", "'{{1,2},{3,4}}'"),
    ("c_numeric_array", "numeric[]", "'{1.50,NaN}'"),
    ("c_date_array", "date[]", "'{2026-01-01,infinity}'"),
    ("c_enum", "gridl_t_mood", "'sad'"),
    ("c_enum_array", "gridl_t_mood[]", "'{ok,sad}'"),
    ("c_composite", "gridl_t_pair", "'(1,\"two words\")'"),
    ("c_domain_int", "gridl_t_positive", "5"),
    ("c_domain_text", "gridl_t_code", "'ABC'"),
    ("c_hstore", "hstore", "'a=>1, b=>NULL'"),
    ("c_citext", "citext", "'MiXeD'"),
    ("c_ltree", "ltree", "'top.science.astronomy'"),
    ("c_cube", "cube", "'(1,2),(3,4)'"),
];

#[tokio::test]
async fn postgres_reads_and_writes_back_every_type() {
    let Some(target) = target() else { return };
    let (driver, id) = open(&target, "pg-types", false).await;
    for sql in [
        "CREATE EXTENSION IF NOT EXISTS hstore",
        "CREATE EXTENSION IF NOT EXISTS citext",
        "CREATE EXTENSION IF NOT EXISTS ltree",
        "CREATE EXTENSION IF NOT EXISTS cube",
        "DROP TABLE IF EXISTS gridl_types",
        "DROP TYPE IF EXISTS gridl_t_mood CASCADE",
        "DROP TYPE IF EXISTS gridl_t_pair CASCADE",
        "DROP DOMAIN IF EXISTS gridl_t_positive CASCADE",
        "DROP DOMAIN IF EXISTS gridl_t_code CASCADE",
        "CREATE TYPE gridl_t_mood AS ENUM ('ok', 'sad')",
        "CREATE TYPE gridl_t_pair AS (n int, label text)",
        "CREATE DOMAIN gridl_t_positive AS int CHECK (VALUE > 0)",
        "CREATE DOMAIN gridl_t_code AS text CHECK (VALUE ~ '^[A-Z]+$')",
    ] {
        run(&driver, &id, sql).await;
    }
    let columns: Vec<String> =
        ALL_TYPES.iter().map(|(name, kind, _)| format!("{name} {kind}")).collect();
    run(
        &driver,
        &id,
        &format!("CREATE TABLE gridl_types (id int PRIMARY KEY, {})", columns.join(", ")),
    )
    .await;
    let names: Vec<&str> = ALL_TYPES.iter().map(|(name, _, _)| *name).collect();
    let samples: Vec<&str> = ALL_TYPES.iter().map(|(_, _, sample)| *sample).collect();
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

    // What PostgreSQL itself prints for each column.
    let printed: Vec<String> = names.iter().map(|name| format!("format('%s', {name})")).collect();
    let expected =
        run(&driver, &id, &format!("SELECT {} FROM gridl_types WHERE id = 1", printed.join(", ")))
            .await;
    let expected = expected.iter().flat_map(|chunk| chunk.rows.iter()).next().expect("row").clone();

    let read = |chunks: Vec<RowChunk>| -> Vec<Vec<SqlValue>> {
        chunks.into_iter().flat_map(|chunk| chunk.rows.into_iter()).collect()
    };
    let shown = |value: &SqlValue| -> String {
        match value {
            SqlValue::Text(text) => text.clone(),
            SqlValue::Int(value) => value.to_string(),
            SqlValue::Float(value) => value.to_string(),
            SqlValue::Bool(value) => {
                if *value {
                    "t".into()
                } else {
                    "f".into()
                }
            }
            SqlValue::Bytes(bytes) => {
                format!("\\x{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
            }
            SqlValue::Null => "NULL".into(),
        }
    };
    let select = format!("SELECT {} FROM gridl_types ORDER BY id", names.join(", "));
    let rows = read(run(&driver, &id, &select).await);
    assert_eq!(rows.len(), 2);
    for (index, (name, kind, _)) in ALL_TYPES.iter().enumerate() {
        let SqlValue::Text(printed) = &expected[index] else { panic!("{name}: printed") };
        assert_eq!(
            &shown(&rows[0][index]),
            printed,
            "{name} ({kind}) reads as PostgreSQL prints it"
        );
        assert_eq!(rows[1][index], SqlValue::Null, "{name} ({kind}) NULL");
    }

    // With parameters the values are inlined and still come back as text, identical.
    let mut sink = VecSink(Vec::new());
    let request = QueryRequest::new(
        "query-params",
        format!(
            "SELECT {} FROM gridl_types WHERE id = $1 AND $2::text = 'it''s' ORDER BY id",
            names.join(", ")
        ),
        vec![SqlValue::Int(1), SqlValue::Text("it's".into())],
        DEFAULT_CHUNK_ROWS,
        MAX_STREAM_ROWS,
        Arc::new(AtomicBool::new(false)),
    )
    .expect("request");
    driver.query(&id, &request, &mut sink).await.expect("select with parameters");
    assert_eq!(read(sink.0), rows[..1].to_vec(), "same values with parameters");

    // Saving a cell sends what the grid shows, cast to the column's type, as the app does.
    let table = driver
        .describe_relation(
            &id,
            &RelationRef {
                schema: Some("public".into()),
                name: "gridl_types".into(),
                kind: RelationKind::Table,
            },
        )
        .await
        .expect("describe");
    for (index, (name, kind, _)) in ALL_TYPES.iter().enumerate() {
        let column = table.columns.iter().find(|column| column.name == *name).expect("column");
        assert!(
            column.data_type != "ARRAY" && column.data_type != "USER-DEFINED",
            "{name} ({kind}) has a castable type name, got {}",
            column.data_type
        );
        let sql = format!("UPDATE gridl_types SET {name} = $1::{} WHERE id = 1", column.data_type);
        let batch = BatchRequest::new(vec![BatchStatement {
            sql: sql.clone(),
            params: vec![rows[0][index].clone()],
        }])
        .expect("batch");
        driver
            .execute_batch(&id, &batch)
            .await
            .unwrap_or_else(|err| panic!("{name} ({kind}): {sql}: {err}"));
    }
    let again = read(run(&driver, &id, &select).await);
    for (index, (name, kind, _)) in ALL_TYPES.iter().enumerate() {
        assert_eq!(
            again[0][index], rows[0][index],
            "{name} ({kind}) is unchanged after saving it back"
        );
    }
    driver.disconnect(&id).await.expect("disconnect");
}

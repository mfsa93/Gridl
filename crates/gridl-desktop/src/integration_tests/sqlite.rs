use super::*;

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

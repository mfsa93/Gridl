use super::*;

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

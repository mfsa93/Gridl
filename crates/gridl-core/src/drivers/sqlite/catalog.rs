use sqlx::{Row, SqlitePool};

use crate::drivers::common::catalog::{push_key_column, table_object};
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, ForeignKey, RelationKind, RelationRef, TableSchema};

pub(super) async fn relations(pool: &SqlitePool) -> Result<Vec<RelationRef>, CoreError> {
    let rows = sqlx::query(
        "SELECT name, type
         FROM sqlite_master
         WHERE type IN ('table', 'view', 'index', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let kind: String = row.try_get("type").map_err(db_err)?;
            Ok(RelationRef {
                schema: None,
                name: row.try_get("name").map_err(db_err)?,
                kind: match kind.as_str() {
                    "view" => RelationKind::View,
                    "index" => RelationKind::Index,
                    "trigger" => RelationKind::Trigger,
                    _ => RelationKind::Table,
                },
            })
        })
        .collect()
}

pub(super) async fn describe(
    pool: &SqlitePool,
    relation: &RelationRef,
) -> Result<TableSchema, CoreError> {
    if relation.schema.as_deref().is_some_and(|schema| schema != "main") {
        return Err(CoreError::InvalidConfig(
            "sqlite attached databases are not supported yet".into(),
        ));
    }
    if matches!(relation.kind, RelationKind::Index | RelationKind::Trigger) {
        let row = sqlx::query("SELECT sql, tbl_name FROM sqlite_master WHERE name = ?1")
            .bind(&relation.name)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
        let (definition, parent) = match &row {
            Some(row) => {
                (row.try_get("sql").map_err(db_err)?, row.try_get("tbl_name").map_err(db_err)?)
            }
            None => (None, String::new()),
        };
        return Ok(table_object(None, relation.name.clone(), relation.kind, definition, parent));
    }
    Ok(TableSchema {
        schema: relation.schema.clone(),
        name: relation.name.clone(),
        kind: relation.kind,
        columns: table_info(pool, &relation.name).await?,
        definition: None,
        returns: None,
        parent: None,
    })
}

async fn table_info(pool: &SqlitePool, table: &str) -> Result<Vec<ColumnDefinition>, CoreError> {
    let rows = sqlx::query("SELECT * FROM pragma_table_info(?1)")
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let not_null: i64 = row.try_get("notnull").map_err(db_err)?;
            let primary_key: i64 = row.try_get("pk").map_err(db_err)?;
            Ok(ColumnDefinition {
                name: row.try_get("name").map_err(db_err)?,
                data_type: row.try_get("type").map_err(db_err)?,
                nullable: not_null == 0,
                primary_key: primary_key > 0,
                default_value: row.try_get("dflt_value").map_err(db_err)?,
                options: Vec::new(),
                mode: None,
            })
        })
        .collect()
}

/// Indexes and triggers of `table`. Automatic indexes (`sqlite_autoindex_…`)
/// have no SQL and are left out, as in the explorer.
pub(super) async fn table_objects(
    pool: &SqlitePool,
    table: &str,
) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT name, type, sql FROM sqlite_master
         WHERE type IN ('index', 'trigger') AND tbl_name = ?1 AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let kind: String = row.try_get("type").map_err(db_err)?;
            let kind = if kind == "index" { RelationKind::Index } else { RelationKind::Trigger };
            Ok(table_object(
                None,
                row.try_get("name").map_err(db_err)?,
                kind,
                row.try_get("sql").map_err(db_err)?,
                table.to_owned(),
            ))
        })
        .collect()
}

/// SQLite keys have no names; they are called `table_fk_<id>`.
pub(super) async fn foreign_keys(pool: &SqlitePool) -> Result<Vec<ForeignKey>, CoreError> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut keys = Vec::new();
    for table in tables {
        let rows = sqlx::query(
            "SELECT id, \"table\" AS ref_table, \"from\" AS column_name, \"to\" AS ref_column,
                    on_update, on_delete
             FROM pragma_foreign_key_list(?1)
             ORDER BY id, seq",
        )
        .bind(&table)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
        for row in &rows {
            let key_id: i64 = row.try_get("id").map_err(db_err)?;
            let key = ForeignKey {
                name: format!("{table}_fk_{key_id}"),
                schema: None,
                table: table.clone(),
                columns: Vec::new(),
                ref_schema: None,
                ref_table: row.try_get("ref_table").map_err(db_err)?,
                ref_columns: Vec::new(),
                on_update: row.try_get("on_update").map_err(db_err)?,
                on_delete: row.try_get("on_delete").map_err(db_err)?,
            };
            let column = row.try_get("column_name").map_err(db_err)?;
            let ref_column = row.try_get("ref_column").map_err(db_err)?;
            push_key_column(&mut keys, key, column, ref_column);
        }
    }
    Ok(keys)
}

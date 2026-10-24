//! Tables, views and their columns and keys, from information_schema.

use std::collections::HashSet;

use sqlx::mysql::{MySqlPool, MySqlRow};
use sqlx::{Row, ValueRef};

use super::objects::{indexes, routines, triggers, view_definitions};
use crate::drivers::common::catalog::{push_column, push_key_column};
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, ForeignKey, RelationKind, RelationRef, TableSchema};

/// Marker the frontend reads as "the server fills this column".
const AUTO_INCREMENT: &str = "auto_increment";

fn relation_kind(table_type: &str) -> RelationKind {
    match table_type {
        "VIEW" | "SYSTEM VIEW" => RelationKind::View,
        "SEQUENCE" => RelationKind::Sequence,
        _ => RelationKind::Table,
    }
}

/// Reads a catalog string. information_schema columns can arrive flagged as
/// binary on MySQL 8, so the type check is skipped.
pub(super) fn text(row: &MySqlRow, name: &str) -> Result<String, CoreError> {
    opt_text(row, name)?.ok_or_else(|| CoreError::Database(format!("{name} is NULL")))
}

pub(super) fn opt_text(row: &MySqlRow, name: &str) -> Result<Option<String>, CoreError> {
    let raw = row.try_get_raw(name).map_err(db_err)?;
    if raw.is_null() {
        return Ok(None);
    }
    row.try_get_unchecked::<String, _>(name).map(Some).map_err(db_err)
}

pub(super) fn opt_int(row: &MySqlRow, name: &str) -> Result<Option<i64>, CoreError> {
    let raw = row.try_get_raw(name).map_err(db_err)?;
    if raw.is_null() {
        return Ok(None);
    }
    row.try_get_unchecked::<i64, _>(name).map(Some).map_err(db_err)
}

pub(super) fn quote_mysql(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

async fn primary_keys(
    pool: &MySqlPool,
    schema: &str,
    table: Option<&str>,
) -> Result<HashSet<(String, String)>, CoreError> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM information_schema.key_column_usage
         WHERE CONSTRAINT_NAME = 'PRIMARY'
           AND TABLE_SCHEMA = ?
           AND (? IS NULL OR TABLE_NAME = ?)",
    )
    .bind(schema)
    .bind(table)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter().map(|row| Ok((text(row, "table_name")?, text(row, "column_name")?))).collect()
}

fn column_from_row(
    row: &MySqlRow,
    keys: &HashSet<(String, String)>,
    mariadb: bool,
) -> Result<ColumnDefinition, CoreError> {
    let table = text(row, "table_name")?;
    let name = text(row, "column_name")?;
    let data_type = text(row, "column_type")?;
    let nullable = text(row, "is_nullable")?;
    let extra = opt_text(row, "extra")?.unwrap_or_default();
    let mut default_value = opt_text(row, "column_default")?;
    // MariaDB reports "no default" on a nullable column as the literal NULL;
    // a string default would arrive quoted.
    if mariadb && default_value.as_deref() == Some("NULL") {
        default_value = None;
    }
    if default_value.is_none() && extra.to_ascii_lowercase().contains(AUTO_INCREMENT) {
        default_value = Some(AUTO_INCREMENT.to_owned());
    }
    Ok(ColumnDefinition {
        primary_key: keys.contains(&(table, name.clone())),
        name,
        options: enum_labels(&data_type),
        mode: None,
        data_type,
        nullable: nullable.eq_ignore_ascii_case("YES"),
        default_value,
    })
}

/// Labels of an `enum('a','b')` or `set('a','b')` column type.
fn enum_labels(column_type: &str) -> Vec<String> {
    let lower = column_type.to_ascii_lowercase();
    let body = if lower.starts_with("enum(") {
        &column_type[5..]
    } else if lower.starts_with("set(") {
        &column_type[4..]
    } else {
        return Vec::new();
    };
    let mut labels = Vec::new();
    let mut chars = body.chars().peekable();
    loop {
        while chars.next_if(|c| *c == ',' || c.is_whitespace()).is_some() {}
        if chars.next() != Some('\'') {
            break;
        }
        let mut label = String::new();
        loop {
            match chars.next() {
                None => return labels,
                Some('\'') if chars.peek() == Some(&'\'') => {
                    chars.next();
                    label.push('\'');
                }
                Some('\'') => break,
                // The catalog escapes a backslash in a label as `\\`.
                Some('\\') => match chars.next() {
                    Some(escaped @ ('\\' | '\'')) => label.push(escaped),
                    Some(other) => {
                        label.push('\\');
                        label.push(other);
                    }
                    None => return labels,
                },
                Some(other) => label.push(other),
            }
        }
        labels.push(label);
    }
    labels
}

/// Columns of the session database's tables and views. Callers add a filter
/// on the table and the order.
const COLUMNS: &str = "SELECT c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
        c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
        c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.EXTRA AS extra
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = ?";

pub(super) async fn relations(
    pool: &MySqlPool,
    database: &str,
) -> Result<Vec<RelationRef>, CoreError> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
         FROM information_schema.tables
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(RelationRef {
                schema: Some(database.to_owned()),
                name: text(row, "table_name")?,
                kind: relation_kind(&text(row, "table_type")?),
            })
        })
        .collect()
}

pub(super) async fn describe(
    pool: &MySqlPool,
    schema: &str,
    mariadb: bool,
    relation: &RelationRef,
) -> Result<TableSchema, CoreError> {
    let keys = primary_keys(pool, schema, Some(&relation.name)).await?;
    let rows = sqlx::query(&format!("{COLUMNS} AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION"))
        .bind(schema)
        .bind(&relation.name)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    Ok(TableSchema {
        schema: Some(schema.to_owned()),
        name: relation.name.clone(),
        kind: relation.kind,
        columns: rows
            .iter()
            .map(|row| column_from_row(row, &keys, mariadb))
            .collect::<Result<_, _>>()?,
        definition: None,
        returns: None,
        parent: None,
    })
}

/// Everything the explorer shows for the session database, read side by side.
pub(super) async fn all(
    pool: &MySqlPool,
    schema: &str,
    mariadb: bool,
) -> Result<Vec<TableSchema>, CoreError> {
    let columns = async {
        sqlx::query(&format!("{COLUMNS} ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(db_err)
    };
    let (keys, views, rows, routines, triggers, indexes) = tokio::try_join!(
        primary_keys(pool, schema, None),
        view_definitions(pool, schema),
        columns,
        routines(pool, schema),
        triggers(pool, schema, None),
        indexes(pool, schema, mariadb, None),
    )?;
    let mut tables: Vec<TableSchema> = Vec::new();
    for row in &rows {
        let name = text(row, "table_name")?;
        let kind = relation_kind(&text(row, "table_type")?);
        let column = column_from_row(row, &keys, mariadb)?;
        push_column(&mut tables, Some(schema), &name, column, || TableSchema {
            schema: Some(schema.to_owned()),
            name: name.clone(),
            kind,
            columns: Vec::new(),
            definition: views
                .get(&name)
                .map(|body| format!("CREATE VIEW {} AS {body}", quote_mysql(&name))),
            returns: None,
            parent: None,
        });
    }
    tables.extend(routines);
    tables.extend(triggers);
    tables.extend(indexes);
    Ok(tables)
}

/// Triggers and indexes of one table.
pub(super) async fn table_objects(
    pool: &MySqlPool,
    schema: &str,
    mariadb: bool,
    table: &str,
) -> Result<Vec<TableSchema>, CoreError> {
    let (mut objects, indexes) = tokio::try_join!(
        triggers(pool, schema, Some(table)),
        indexes(pool, schema, mariadb, Some(table)),
    )?;
    objects.extend(indexes);
    Ok(objects)
}

pub(super) async fn foreign_keys(
    pool: &MySqlPool,
    schema: &str,
) -> Result<Vec<ForeignKey>, CoreError> {
    let rows = sqlx::query(
        "SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name,
                k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS ref_schema,
                k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column,
                r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut keys = Vec::new();
    for row in &rows {
        let key = ForeignKey {
            name: text(row, "name")?,
            schema: Some(schema.to_owned()),
            table: text(row, "table_name")?,
            columns: Vec::new(),
            ref_schema: Some(text(row, "ref_schema")?),
            ref_table: text(row, "ref_table")?,
            ref_columns: Vec::new(),
            on_update: text(row, "on_update")?,
            on_delete: text(row, "on_delete")?,
        };
        push_key_column(&mut keys, key, text(row, "column_name")?, Some(text(row, "ref_column")?));
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_labels_handle_quotes_and_sets() {
        assert_eq!(enum_labels("enum('a','it''s','c d')"), vec!["a", "it's", "c d"]);
        assert_eq!(enum_labels("set('x','y')"), vec!["x", "y"]);
        assert_eq!(enum_labels("ENUM('A')"), vec!["A"]);
        assert!(enum_labels("varchar(10)").is_empty());
        assert_eq!(enum_labels("enum('')"), vec![""]);
        assert_eq!(enum_labels(r"enum('a\\b','c')"), vec![r"a\b", "c"]);
    }
}

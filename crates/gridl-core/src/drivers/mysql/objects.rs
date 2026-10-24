//! Views, routines, triggers and indexes of the session's database.

use std::collections::HashMap;

use sqlx::mysql::MySqlPool;

use super::catalog::{opt_int, opt_text, quote_mysql, text};
use crate::drivers::common::catalog::{plain_column, table_object};
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, RelationKind, TableSchema};

/// Routine parameter: mode (procedures only), name, and declared type.
type Parameter = (Option<String>, String, String);

pub(super) async fn view_definitions(
    pool: &MySqlPool,
    schema: &str,
) -> Result<HashMap<String, String>, CoreError> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME AS name, VIEW_DEFINITION AS body
         FROM information_schema.views
         WHERE TABLE_SCHEMA = ?",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut views = HashMap::new();
    for row in &rows {
        if let Some(body) = opt_text(row, "body")?.filter(|body| !body.is_empty()) {
            views.insert(text(row, "name")?, body);
        }
    }
    Ok(views)
}

pub(super) async fn routines(
    pool: &MySqlPool,
    schema: &str,
) -> Result<Vec<TableSchema>, CoreError> {
    let params = sqlx::query(
        "SELECT SPECIFIC_NAME AS specific_name, ROUTINE_TYPE AS routine_type,
                PARAMETER_MODE AS parameter_mode, PARAMETER_NAME AS parameter_name,
                DTD_IDENTIFIER AS data_type
         FROM information_schema.parameters
         WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
         ORDER BY SPECIFIC_NAME, ORDINAL_POSITION",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut arguments: HashMap<(String, String), Vec<Parameter>> = HashMap::new();
    for row in &params {
        let key = (text(row, "routine_type")?, text(row, "specific_name")?);
        let name = opt_text(row, "parameter_name")?.unwrap_or_default();
        let data_type = opt_text(row, "data_type")?.unwrap_or_default();
        let mode = opt_text(row, "parameter_mode")?;
        arguments.entry(key).or_default().push((mode, name, data_type));
    }

    let rows = sqlx::query(
        "SELECT SPECIFIC_NAME AS specific_name, ROUTINE_NAME AS routine_name,
                ROUTINE_TYPE AS routine_type, DTD_IDENTIFIER AS returns,
                ROUTINE_DEFINITION AS body
         FROM information_schema.routines
         WHERE ROUTINE_SCHEMA = ?
         ORDER BY ROUTINE_NAME",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let kind = text(row, "routine_type")?;
            let name = text(row, "routine_name")?;
            let specific = text(row, "specific_name")?;
            let procedure = kind.eq_ignore_ascii_case("PROCEDURE");
            let args = arguments.get(&(kind, specific)).map(Vec::as_slice).unwrap_or_default();
            let signature = args
                .iter()
                .map(|(mode, arg, data_type)| match mode {
                    Some(mode) if procedure => {
                        format!("{mode} {} {data_type}", quote_mysql(arg))
                    }
                    _ => format!("{} {data_type}", quote_mysql(arg)),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let returns = opt_text(row, "returns")?.filter(|_| !procedure);
            let definition = opt_text(row, "body")?.map(|body| {
                let header = if procedure { "PROCEDURE" } else { "FUNCTION" };
                let returns =
                    returns.as_deref().map(|ty| format!(" RETURNS {ty}")).unwrap_or_default();
                format!("CREATE {header} {}({signature}){returns}\n{body}", quote_mysql(&name))
            });
            Ok(TableSchema {
                schema: Some(schema.to_owned()),
                name,
                kind: if procedure { RelationKind::Procedure } else { RelationKind::Function },
                columns: args
                    .iter()
                    .map(|(mode, arg, data_type)| ColumnDefinition {
                        // Function parameters have no mode in the catalog; they are all inputs.
                        mode: Some(mode.clone().unwrap_or_else(|| "IN".to_owned())),
                        ..plain_column(arg, data_type)
                    })
                    .collect(),
                definition,
                returns,
                parent: None,
            })
        })
        .collect()
}

/// Triggers of the schema's tables, or of `table` alone.
pub(super) async fn triggers(
    pool: &MySqlPool,
    schema: &str,
    table: Option<&str>,
) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT TRIGGER_NAME AS trigger_name, ACTION_TIMING AS timing,
                EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS table_name,
                ACTION_STATEMENT AS body
         FROM information_schema.triggers
         WHERE TRIGGER_SCHEMA = ? AND (? IS NULL OR EVENT_OBJECT_TABLE = ?)
         ORDER BY TRIGGER_NAME",
    )
    .bind(schema)
    .bind(table)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let name = text(row, "trigger_name")?;
            let parent = text(row, "table_name")?;
            let definition = format!(
                "CREATE TRIGGER {} {} {} ON {} FOR EACH ROW {}",
                quote_mysql(&name),
                text(row, "timing")?,
                text(row, "event")?,
                quote_mysql(&parent),
                opt_text(row, "body")?.unwrap_or_default(),
            );
            Ok(table_object(
                Some(schema.to_owned()),
                name,
                RelationKind::Trigger,
                Some(definition),
                parent,
            ))
        })
        .collect()
}

/// Indexes of the schema's tables, or of `table` alone. They are named
/// `table.index`: MySQL scopes index names to a table, so every table has its
/// own `PRIMARY`.
pub(super) async fn indexes(
    pool: &MySqlPool,
    schema: &str,
    mariadb: bool,
    table: Option<&str>,
) -> Result<Vec<TableSchema>, CoreError> {
    // Functional key parts (MySQL 8.0.13+) have no column, only an expression.
    let expression = if mariadb { "NULL" } else { "EXPRESSION" };
    let sql = format!(
        "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
                NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name,
                {expression} AS expression, SUB_PART AS sub_part,
                COLLATION AS collation, INDEX_TYPE AS index_type
         FROM information_schema.statistics
         WHERE TABLE_SCHEMA = ? AND (? IS NULL OR TABLE_NAME = ?)
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
    );
    let rows = sqlx::query(&sql)
        .bind(schema)
        .bind(table)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;

    struct Index {
        table: String,
        name: String,
        unique: bool,
        index_type: String,
        parts: Vec<String>,
    }
    let mut found: Vec<Index> = Vec::new();
    for row in &rows {
        let table = text(row, "table_name")?;
        let name = text(row, "index_name")?;
        let mut part = match opt_text(row, "column_name")? {
            Some(column) => quote_mysql(&column),
            None => format!("({})", opt_text(row, "expression")?.unwrap_or_default()),
        };
        if let Some(length) = opt_int(row, "sub_part")? {
            part.push_str(&format!("({length})"));
        }
        if opt_text(row, "collation")?.as_deref() == Some("D") {
            part.push_str(" DESC");
        }
        match found.last_mut() {
            Some(index) if index.table == table && index.name == name => index.parts.push(part),
            _ => found.push(Index {
                unique: opt_int(row, "non_unique")? == Some(0),
                index_type: opt_text(row, "index_type")?.unwrap_or_default(),
                table,
                name,
                parts: vec![part],
            }),
        }
    }
    Ok(found
        .into_iter()
        .map(|index| {
            let parts = index.parts.join(", ");
            let table = quote_mysql(&index.table);
            let definition = if index.name == "PRIMARY" {
                format!("ALTER TABLE {table} ADD PRIMARY KEY ({parts})")
            } else {
                let prefix = match index.index_type.as_str() {
                    "FULLTEXT" => "FULLTEXT ",
                    "SPATIAL" => "SPATIAL ",
                    _ if index.unique => "UNIQUE ",
                    _ => "",
                };
                let using = if index.index_type == "HASH" { " USING HASH" } else { "" };
                format!(
                    "CREATE {prefix}INDEX {} ON {table} ({parts}){using}",
                    quote_mysql(&index.name)
                )
            };
            table_object(
                Some(schema.to_owned()),
                format!("{}.{}", index.table, index.name),
                RelationKind::Index,
                Some(definition),
                index.table,
            )
        })
        .collect())
}

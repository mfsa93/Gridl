//! Routines, triggers and indexes, for the explorer.

use std::collections::HashMap;

use super::catalog::{object_kind, quote, sized_type};
use super::decode::{flag, int, opt_text, text};
use super::pool::Pool;
use crate::drivers::common::catalog::{table_object, TableFilter};
use crate::error::CoreError;
use crate::types::{ColumnDefinition, RelationKind, TableSchema};

pub(super) async fn routines(pool: &Pool) -> Result<Vec<TableSchema>, CoreError> {
    let (params, rows) = tokio::try_join!(
        pool.rows(
            "SELECT p.object_id, p.name, TYPE_NAME(p.user_type_id), p.max_length, p.precision,
                    p.scale, p.is_output, p.parameter_id
             FROM sys.parameters p JOIN sys.objects o ON o.object_id = p.object_id
             WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
             ORDER BY p.object_id, p.parameter_id",
            &[],
        ),
        pool.rows(
            "SELECT o.object_id, s.name, o.name, o.type, OBJECT_DEFINITION(o.object_id)
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
             ORDER BY s.name, o.name",
            &[],
        ),
    )?;
    let mut arguments: HashMap<i64, Vec<ColumnDefinition>> = HashMap::new();
    let mut returns: HashMap<i64, String> = HashMap::new();
    for row in &params {
        let object = int(row, 0);
        let data_type = sized_type(&text(row, 2)?, int(row, 3), int(row, 4), int(row, 5));
        // Parameter 0 is a scalar function's return value.
        if int(row, 7) == 0 {
            returns.insert(object, data_type);
            continue;
        }
        arguments.entry(object).or_default().push(ColumnDefinition {
            name: text(row, 1)?,
            data_type,
            nullable: true,
            primary_key: false,
            default_value: None,
            options: Vec::new(),
            mode: Some(if flag(row, 6) { "INOUT" } else { "IN" }.to_owned()),
        });
    }
    rows.iter()
        .map(|row| {
            let object = int(row, 0);
            let code = text(row, 3)?;
            let kind = object_kind(&code);
            let returns = match code.trim() {
                "IF" | "TF" => Some("TABLE".to_owned()),
                _ => returns.remove(&object),
            };
            Ok(TableSchema {
                schema: Some(text(row, 1)?),
                name: text(row, 2)?,
                kind,
                columns: arguments.remove(&object).unwrap_or_default(),
                definition: opt_text(row, 4),
                returns,
                parent: None,
            })
        })
        .collect()
}

/// The SQL filter and parameters for `only`, on schema alias `s` and table alias `t`.
fn table_filter<'a>(only: TableFilter<'a>, table: &str) -> (String, Vec<&'a str>) {
    match only {
        Some((schema, name)) => {
            (format!("AND s.name = @P1 AND {table}.name = @P2"), vec![schema, name])
        }
        None => (String::new(), Vec::new()),
    }
}

/// Triggers and indexes of every table, or of `only` one.
pub(super) async fn table_objects(
    pool: &Pool,
    only: TableFilter<'_>,
) -> Result<Vec<TableSchema>, CoreError> {
    let (mut objects, indexes) = tokio::try_join!(triggers(pool, only), indexes(pool, only))?;
    objects.extend(indexes);
    Ok(objects)
}

async fn triggers(pool: &Pool, only: TableFilter<'_>) -> Result<Vec<TableSchema>, CoreError> {
    let (filter, params) = table_filter(only, "o");
    let sql = format!(
        "SELECT s.name, t.name, OBJECT_DEFINITION(t.object_id), o.name
         FROM sys.triggers t
         JOIN sys.objects o ON o.object_id = t.parent_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE t.is_ms_shipped = 0 {filter}
         ORDER BY s.name, t.name"
    );
    let rows = pool.rows(&sql, &params).await?;
    rows.iter()
        .map(|row| {
            Ok(table_object(
                Some(text(row, 0)?),
                text(row, 1)?,
                RelationKind::Trigger,
                opt_text(row, 2),
                text(row, 3)?,
            ))
        })
        .collect()
}

/// Indexes are named `table.index`: SQL Server scopes index names to a table.
async fn indexes(pool: &Pool, only: TableFilter<'_>) -> Result<Vec<TableSchema>, CoreError> {
    let (filter, params) = table_filter(only, "t");
    let rows = pool
        .rows(
            &format!(
                "SELECT s.name, t.name, i.name, i.is_primary_key, i.is_unique, i.type_desc,
                    c.name, ic.is_descending_key, ic.is_included_column, i.filter_definition
             FROM sys.indexes i
             JOIN sys.tables t ON t.object_id = i.object_id
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE t.is_ms_shipped = 0 AND i.name IS NOT NULL {filter}
             ORDER BY s.name, t.name, i.name, ic.is_included_column, ic.key_ordinal"
            ),
            &params,
        )
        .await?;

    struct Index {
        schema: String,
        table: String,
        name: String,
        primary: bool,
        unique: bool,
        kind: String,
        keys: Vec<String>,
        included: Vec<String>,
        filter: Option<String>,
    }
    let mut found: Vec<Index> = Vec::new();
    for row in &rows {
        let schema = text(row, 0)?;
        let table = text(row, 1)?;
        let name = text(row, 2)?;
        let column = quote(&text(row, 6)?);
        let index = match found.last_mut() {
            Some(index) if index.schema == schema && index.table == table && index.name == name => {
                index
            }
            _ => {
                found.push(Index {
                    primary: flag(row, 3),
                    unique: flag(row, 4),
                    kind: text(row, 5)?,
                    filter: opt_text(row, 9),
                    schema,
                    table,
                    name,
                    keys: Vec::new(),
                    included: Vec::new(),
                });
                found.last_mut().ok_or_else(|| CoreError::Internal("index list".into()))?
            }
        };
        if flag(row, 8) {
            index.included.push(column);
        } else if flag(row, 7) {
            index.keys.push(format!("{column} DESC"));
        } else {
            index.keys.push(column);
        }
    }
    Ok(found
        .into_iter()
        .map(|index| {
            let table = format!("{}.{}", quote(&index.schema), quote(&index.table));
            let keys = index.keys.join(", ");
            let clustered = if index.kind == "CLUSTERED" { "CLUSTERED" } else { "NONCLUSTERED" };
            let mut definition = if index.primary {
                format!(
                    "ALTER TABLE {table} ADD CONSTRAINT {} PRIMARY KEY {clustered} ({keys})",
                    quote(&index.name)
                )
            } else {
                let unique = if index.unique { "UNIQUE " } else { "" };
                format!(
                    "CREATE {unique}{clustered} INDEX {} ON {table} ({keys})",
                    quote(&index.name)
                )
            };
            if !index.included.is_empty() {
                definition.push_str(&format!(" INCLUDE ({})", index.included.join(", ")));
            }
            if let Some(filter) = &index.filter {
                definition.push_str(&format!(" WHERE {filter}"));
            }
            table_object(
                Some(index.schema),
                format!("{}.{}", index.table, index.name),
                RelationKind::Index,
                Some(definition),
                index.table,
            )
        })
        .collect())
}

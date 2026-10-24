//! Tables, views and their columns, and foreign keys, from the sys catalog views.

use tiberius::Row;

use super::decode::{flag, int, opt_text, text};
use super::lexer::{lex, Lexeme};
use super::objects::{routines, table_objects};
use super::pool::Pool;
use crate::drivers::common::catalog::{push_column, push_key_column};
use crate::error::CoreError;
use crate::types::{ColumnDefinition, ForeignKey, RelationKind, RelationRef, TableSchema};

/// Default the frontend reads as "the server fills this column".
const IDENTITY: &str = "identity";

pub(super) fn object_kind(code: &str) -> RelationKind {
    match code.trim() {
        "V" => RelationKind::View,
        "P" | "PC" => RelationKind::Procedure,
        "FN" | "IF" | "TF" | "FS" | "FT" => RelationKind::Function,
        "TR" => RelationKind::Trigger,
        "SO" => RelationKind::Sequence,
        _ => RelationKind::Table,
    }
}

pub(super) fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Columns of user tables and views, with a definition for views. Callers add
/// filters (`AND …`) and then [`COLUMNS_ORDER`].
const COLUMNS_SQL: &str = "SELECT s.name, o.name, o.type, c.name, TYPE_NAME(c.user_type_id),
        c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
        OBJECT_DEFINITION(c.default_object_id),
        CAST(CASE WHEN EXISTS (
            SELECT 1 FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
        ) THEN 1 ELSE 0 END AS bit),
        c.is_computed,
        CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) END
    FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0";

const COLUMNS_ORDER: &str = "ORDER BY s.name, o.name, c.column_id";

fn column_from_row(row: &Row) -> Result<ColumnDefinition, CoreError> {
    let type_name = text(row, 4)?;
    let data_type = sized_type(&type_name, int(row, 5), int(row, 6), int(row, 7));
    let default_value = if flag(row, 9) {
        Some(IDENTITY.to_owned())
    } else if flag(row, 12) {
        Some("computed".to_owned())
    } else {
        opt_text(row, 10).map(|text| unwrap_parens(&text).to_owned())
    };
    Ok(ColumnDefinition {
        name: text(row, 3)?,
        data_type,
        nullable: flag(row, 8),
        primary_key: flag(row, 11),
        default_value,
        options: Vec::new(),
        mode: None,
    })
}

/// The type as it is written in DDL: `nvarchar(50)`, `decimal(10,2)`, `varbinary(max)`.
pub(super) fn sized_type(name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    let lower = name.to_ascii_lowercase();
    let length = |bytes_per_char: i64| {
        if max_length < 0 {
            "max".to_owned()
        } else {
            (max_length / bytes_per_char).to_string()
        }
    };
    match lower.as_str() {
        "nvarchar" | "nchar" => format!("{lower}({})", length(2)),
        "varchar" | "char" | "varbinary" | "binary" => format!("{lower}({})", length(1)),
        "decimal" | "numeric" => format!("{lower}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" if scale != 7 => format!("{lower}({scale})"),
        "float" if precision != 53 => format!("float({precision})"),
        _ => name.to_owned(),
    }
}

/// SQL Server keeps defaults wrapped in parentheses: `((0))`, `(getdate())`.
fn unwrap_parens(text: &str) -> &str {
    let mut text = text.trim();
    while text.starts_with('(') && text.ends_with(')') && balanced(&text[1..text.len() - 1]) {
        text = text[1..text.len() - 1].trim();
    }
    text
}

fn balanced(text: &str) -> bool {
    let mut depth: i32 = 0;
    for (c, kind) in lex(text) {
        if kind != Lexeme::Code {
            continue;
        }
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

pub(super) async fn relations(pool: &Pool) -> Result<Vec<RelationRef>, CoreError> {
    let rows = pool
        .rows(
            "SELECT s.name, o.name, o.type
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
             ORDER BY s.name, o.name",
            &[],
        )
        .await?;
    rows.iter()
        .map(|row| {
            Ok(RelationRef {
                schema: Some(text(row, 0)?),
                name: text(row, 1)?,
                kind: object_kind(&text(row, 2)?),
            })
        })
        .collect()
}

pub(super) async fn describe(
    pool: &Pool,
    relation: &RelationRef,
) -> Result<TableSchema, CoreError> {
    let schema = relation.schema.clone().unwrap_or_else(|| "dbo".to_owned());
    let sql = format!("{COLUMNS_SQL} AND s.name = @P1 AND o.name = @P2 {COLUMNS_ORDER}");
    let rows = pool.rows(&sql, &[&schema, &relation.name]).await?;
    Ok(TableSchema {
        schema: Some(schema),
        name: relation.name.clone(),
        kind: relation.kind,
        columns: rows.iter().map(column_from_row).collect::<Result<_, _>>()?,
        definition: None,
        returns: None,
        parent: None,
    })
}

/// Everything the explorer shows, read side by side on separate connections.
pub(super) async fn all(pool: &Pool) -> Result<Vec<TableSchema>, CoreError> {
    let columns_sql = format!("{COLUMNS_SQL} {COLUMNS_ORDER}");
    let (rows, routines, attached) =
        tokio::try_join!(pool.rows(&columns_sql, &[]), routines(pool), table_objects(pool, None),)?;
    let mut tables: Vec<TableSchema> = Vec::new();
    for row in &rows {
        let schema = text(row, 0)?;
        let name = text(row, 1)?;
        let column = column_from_row(row)?;
        push_column(&mut tables, Some(&schema), &name, column, || TableSchema {
            schema: Some(schema.clone()),
            name: name.clone(),
            kind: object_kind(&opt_text(row, 2).unwrap_or_default()),
            columns: Vec::new(),
            definition: opt_text(row, 13),
            returns: None,
            parent: None,
        });
    }
    tables.extend(routines);
    tables.extend(attached);
    Ok(tables)
}

pub(super) async fn foreign_keys(pool: &Pool) -> Result<Vec<ForeignKey>, CoreError> {
    let rows = pool
        .rows(
            "SELECT fk.name, s.name, t.name, c.name, rs.name, rt.name, rc.name,
                    fk.update_referential_action_desc, fk.delete_referential_action_desc
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = fk.object_id
             JOIN sys.tables t ON t.object_id = fk.parent_object_id
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             JOIN sys.columns c ON c.object_id = fc.parent_object_id
              AND c.column_id = fc.parent_column_id
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
             JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id
              AND rc.column_id = fc.referenced_column_id
             ORDER BY s.name, t.name, fk.name, fc.constraint_column_id",
            &[],
        )
        .await?;
    let mut keys = Vec::new();
    for row in &rows {
        let key = ForeignKey {
            name: text(row, 0)?,
            schema: Some(text(row, 1)?),
            table: text(row, 2)?,
            columns: Vec::new(),
            ref_schema: Some(text(row, 4)?),
            ref_table: text(row, 5)?,
            ref_columns: Vec::new(),
            // NO_ACTION, SET_NULL… as the other engines spell them.
            on_update: text(row, 7)?.replace('_', " "),
            on_delete: text(row, 8)?.replace('_', " "),
        };
        push_key_column(&mut keys, key, text(row, 3)?, Some(text(row, 6)?));
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_types_as_ddl_does() {
        assert_eq!(sized_type("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(sized_type("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(sized_type("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(sized_type("datetime2", 8, 27, 7), "datetime2");
        assert_eq!(sized_type("datetime2", 7, 23, 3), "datetime2(3)");
        assert_eq!(sized_type("int", 4, 10, 0), "int");
        assert_eq!(unwrap_parens("((0))"), "0");
        assert_eq!(unwrap_parens("(getdate())"), "getdate()");
        assert_eq!(unwrap_parens("((1)+(2))"), "(1)+(2)");
        assert_eq!(unwrap_parens("(N')(')"), "N')('");
    }
}

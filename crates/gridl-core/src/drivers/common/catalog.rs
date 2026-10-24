use crate::types::{ColumnDefinition, ForeignKey, RelationKind, TableSchema};

/// A column known only by name and type: routine arguments, sequence types.
pub(crate) fn plain_column(name: &str, data_type: &str) -> ColumnDefinition {
    ColumnDefinition {
        name: name.to_owned(),
        data_type: data_type.to_owned(),
        nullable: true,
        primary_key: false,
        default_value: None,
        options: Vec::new(),
        mode: None,
    }
}

/// An index or trigger: a definition that belongs to `parent`, a table in the same schema.
pub(crate) fn table_object(
    schema: Option<String>,
    name: String,
    kind: RelationKind,
    definition: Option<String>,
    parent: String,
) -> TableSchema {
    TableSchema {
        schema,
        name,
        kind,
        columns: Vec::new(),
        definition,
        returns: None,
        parent: Some(parent),
    }
}

/// Which tables an object reader covers: all of them, or one (schema, table).
pub(crate) type TableFilter<'a> = Option<(&'a str, &'a str)>;

/// Adds `column` to `tables`. Catalog queries return one row per column,
/// ordered by table, so a column either continues the last table or starts a
/// new one, which `start` describes.
pub(crate) fn push_column(
    tables: &mut Vec<TableSchema>,
    schema: Option<&str>,
    table: &str,
    column: ColumnDefinition,
    start: impl FnOnce() -> TableSchema,
) {
    match tables.last_mut() {
        Some(last) if last.name == table && last.schema.as_deref() == schema => {
            last.columns.push(column);
        }
        _ => {
            let mut fresh = start();
            fresh.columns.push(column);
            tables.push(fresh);
        }
    }
}

/// Adds one column pair to `keys`, like [`push_column`]: rows come one per
/// column, ordered by key, so the pair continues the last key when `key`
/// names the same one, and starts `key` otherwise.
pub(crate) fn push_key_column(
    keys: &mut Vec<ForeignKey>,
    key: ForeignKey,
    column: String,
    ref_column: Option<String>,
) {
    let continues = keys.last().is_some_and(|last| {
        last.name == key.name && last.table == key.table && last.schema == key.schema
    });
    if !continues {
        keys.push(key);
    }
    if let Some(last) = keys.last_mut() {
        last.columns.push(column);
        last.ref_columns.extend(ref_column);
    }
}

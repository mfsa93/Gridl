use sqlx::{Column, TypeInfo};

use crate::types::ColumnDefinition;
use crate::value::SqlValue;

pub(crate) const MAX_CELL_BYTES: usize = 256 * 1024;

pub(crate) fn column_defs(columns: &[impl Column]) -> Vec<ColumnDefinition> {
    columns
        .iter()
        .map(|column| ColumnDefinition {
            name: column.name().to_owned(),
            data_type: column.type_info().name().to_owned(),
            nullable: true,
            primary_key: false,
            default_value: None,
            options: Vec::new(),
            mode: None,
        })
        .collect()
}

pub(crate) fn cap_text(value: String) -> SqlValue {
    if value.len() > MAX_CELL_BYTES {
        SqlValue::Text(format!("<text {} bytes>", value.len()))
    } else {
        SqlValue::Text(value)
    }
}

pub(crate) fn cap_bytes(value: Vec<u8>) -> SqlValue {
    if value.len() > MAX_CELL_BYTES {
        SqlValue::Text(format!("<blob {} bytes>", value.len()))
    } else {
        SqlValue::Bytes(value)
    }
}

pub(crate) fn finite_f64(value: f64) -> SqlValue {
    if value.is_finite() {
        SqlValue::Float(value)
    } else {
        SqlValue::Text(value.to_string())
    }
}

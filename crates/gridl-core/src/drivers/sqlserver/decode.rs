//! Values of a result row, and catalog values read by position.

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use tiberius::{ColumnData, FromSql, Row};

use crate::drivers::common::decode::{cap_bytes, cap_text, finite_f64};
use crate::error::CoreError;
use crate::value::SqlValue;

pub(super) fn decode_row(row: &Row) -> Vec<SqlValue> {
    row.cells().map(|(_, data)| decode_cell(data)).collect()
}

fn decode_cell(data: &ColumnData<'static>) -> SqlValue {
    let decoded = match data {
        ColumnData::U8(value) => value.map(|value| SqlValue::Int(value.into())),
        ColumnData::I16(value) => value.map(|value| SqlValue::Int(value.into())),
        ColumnData::I32(value) => value.map(|value| SqlValue::Int(value.into())),
        ColumnData::I64(value) => value.map(SqlValue::Int),
        ColumnData::F32(value) => value.map(|value| finite_f64(f64::from(value))),
        ColumnData::F64(value) => value.map(finite_f64),
        ColumnData::Bit(value) => value.map(SqlValue::Bool),
        ColumnData::String(value) => value.as_ref().map(|value| cap_text(value.to_string())),
        // Upper case, as SQL Server prints them.
        ColumnData::Guid(value) => {
            value.map(|value| SqlValue::Text(value.to_string().to_ascii_uppercase()))
        }
        ColumnData::Binary(value) => value.as_ref().map(|value| cap_bytes(value.to_vec())),
        ColumnData::Numeric(value) => value.map(|value| SqlValue::Text(value.to_string())),
        ColumnData::Xml(value) => value.as_ref().map(|value| cap_text(value.to_string())),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            temporal::<NaiveDateTime>(data, "%Y-%m-%d %H:%M:%S%.f")
        }
        ColumnData::Date(_) => temporal::<NaiveDate>(data, "%Y-%m-%d"),
        ColumnData::Time(_) => temporal::<NaiveTime>(data, "%H:%M:%S%.f"),
        ColumnData::DateTimeOffset(_) => {
            temporal::<DateTime<FixedOffset>>(data, "%Y-%m-%d %H:%M:%S%.f %:z")
        }
    };
    decoded.unwrap_or(SqlValue::Null)
}

fn temporal<'a, T>(data: &'a ColumnData<'static>, format: &str) -> Option<SqlValue>
where
    T: FromSql<'a> + Formatted,
{
    match T::from_sql(data) {
        Ok(value) => value.map(|value| SqlValue::Text(value.formatted(format))),
        Err(err) => Some(SqlValue::Text(format!("<{err}>"))),
    }
}

/// chrono types that print with a format string.
trait Formatted {
    fn formatted(&self, format: &str) -> String;
}

macro_rules! formatted {
    ($($ty:ty),*) => {$(
        impl Formatted for $ty {
            fn formatted(&self, format: &str) -> String {
                self.format(format).to_string()
            }
        }
    )*};
}
formatted!(NaiveDateTime, NaiveDate, NaiveTime, DateTime<FixedOffset>);

pub(super) fn opt_text(row: &Row, index: usize) -> Option<String> {
    let (_, data) = row.cells().nth(index)?;
    // Catalog text (view and routine bodies) is not capped like result cells.
    if let ColumnData::String(value) = data {
        return value.as_ref().map(|value| value.to_string());
    }
    match decode_cell(data) {
        SqlValue::Text(value) => Some(value),
        SqlValue::Int(value) => Some(value.to_string()),
        SqlValue::Float(value) => Some(value.to_string()),
        SqlValue::Bool(value) => Some(u8::from(value).to_string()),
        SqlValue::Null | SqlValue::Bytes(_) => None,
    }
}

pub(super) fn text(row: &Row, index: usize) -> Result<String, CoreError> {
    opt_text(row, index)
        .ok_or_else(|| CoreError::Database(format!("catalog column {index} is NULL")))
}

pub(super) fn int(row: &Row, index: usize) -> i64 {
    match row.cells().nth(index).map(|(_, data)| decode_cell(data)) {
        Some(SqlValue::Int(value)) => value,
        Some(SqlValue::Bool(value)) => i64::from(value),
        _ => 0,
    }
}

pub(super) fn flag(row: &Row, index: usize) -> bool {
    int(row, index) != 0
}

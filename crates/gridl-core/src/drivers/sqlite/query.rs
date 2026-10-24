use std::time::Instant;

use sqlx::pool::PoolConnection;
use sqlx::sqlite::SqliteRow;
use sqlx::{Executor, Row, Sqlite, Statement, TypeInfo, ValueRef};

use crate::driver::ChunkSink;
use crate::drivers::common::bind::bound;
use crate::drivers::common::decode::{cap_bytes, cap_text, column_defs, finite_f64};
use crate::drivers::common::stream::{emit_chunks, StreamConfig};
use crate::drivers::common::{db_err, result};
use crate::error::CoreError;
use crate::types::{QueryRequest, QueryResult};
use crate::value::SqlValue;

/// Runs the editor's SQL on `connection`, streaming rows if it returns any.
pub(super) async fn run(
    connection: &mut PoolConnection<Sqlite>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let statement = connection.prepare(&request.sql).await.map_err(db_err)?;
    let columns = column_defs(statement.columns());
    if columns.is_empty() {
        let affected = bound::<Sqlite>(&request.sql, &request.params)?
            .execute(&mut **connection)
            .await
            .map_err(db_err)?
            .rows_affected();
        return result::done(sink, request, started, affected).await;
    }
    let mut stream = bound::<Sqlite>(&request.sql, &request.params)?.fetch(&mut **connection);
    let outcome = emit_chunks(
        futures_util::TryStreamExt::map_err(&mut stream, db_err),
        StreamConfig::new(request, &columns),
        decode_row,
        sink,
    )
    .await?;
    Ok(result::streamed(request, started, columns, &outcome, 0))
}

fn decode_row(row: &SqliteRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_cell(row, index)).collect()
}

/// SQLite types are per value, so the declared type is only a first guess.
fn decode_cell(row: &SqliteRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    match raw.type_info().name() {
        "BOOLEAN" | "BOOL" => {
            row.try_get::<bool, _>(index).map_or_else(|_| any_value(row, index), SqlValue::Bool)
        }
        "INTEGER" | "INT" | "INT8" | "BIGINT" => {
            row.try_get::<i64, _>(index).map_or_else(|_| any_value(row, index), SqlValue::Int)
        }
        "REAL" | "FLOAT" | "DOUBLE" => {
            row.try_get::<f64, _>(index).map_or_else(|_| any_value(row, index), finite_f64)
        }
        "BLOB" | "BINARY" => {
            row.try_get::<Vec<u8>, _>(index).map_or_else(|_| any_value(row, index), cap_bytes)
        }
        _ => row.try_get::<String, _>(index).map_or_else(|_| any_value(row, index), cap_text),
    }
}

fn any_value(row: &SqliteRow, index: usize) -> SqlValue {
    if let Ok(value) = row.try_get::<i64, _>(index) {
        return SqlValue::Int(value);
    }
    if let Ok(value) = row.try_get::<f64, _>(index) {
        return finite_f64(value);
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return cap_text(value);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return cap_bytes(value);
    }
    SqlValue::Text("<unsupported>".into())
}

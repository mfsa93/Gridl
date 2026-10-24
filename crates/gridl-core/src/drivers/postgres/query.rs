use std::time::Instant;

use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgPool, PgRow, PgTypeInfo, PgValueFormat};
use sqlx::{Executor, Postgres, Row, Statement, TypeInfo, ValueRef};

use super::catalog::attach_enum_options;
use super::literal::inline_params;
use super::EnumLabels;
use crate::driver::ChunkSink;
use crate::drivers::common::bind::bound;
use crate::drivers::common::decode::{cap_bytes, cap_text, column_defs};
use crate::drivers::common::stream::{emit_chunks, StreamConfig};
use crate::drivers::common::{db_err, result};
use crate::error::CoreError;
use crate::types::{ColumnDefinition, QueryRequest, QueryResult};
use crate::value::SqlValue;

/// A connection kept between queries, with the backend pid that cancels it.
pub(super) struct Pinned {
    pub connection: PoolConnection<Postgres>,
    pub pid: i32,
}

impl Pinned {
    pub(super) async fn acquire(pool: &PgPool) -> Result<Self, CoreError> {
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .map_err(db_err)?;
        Ok(Self { connection, pid })
    }
}

/// Asks the server to interrupt `pid`'s statement, from another connection.
pub(super) async fn cancel_backend(pool: &PgPool, pid: i32) {
    let _ = sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(pool).await;
}

pub(super) async fn run(
    connection: &mut PoolConnection<Postgres>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    enums: &EnumLabels,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let columns = statement_columns(connection, request, enums).await?;
    if columns.is_empty() {
        let affected = bound::<Postgres>(&request.sql, &request.params)?
            .execute(&mut **connection)
            .await
            .map_err(db_err)?
            .rows_affected();
        return result::done(sink, request, started, affected).await;
    }
    // Reads use the simple protocol: PostgreSQL then sends every value as text, printed by the
    // type's own output function, so any type (extensions included) reads as psql shows it.
    // Some types (aclitem) cannot be sent in binary at all, and chrono panics on ±infinity.
    let sql = if request.params.is_empty() {
        request.sql.clone()
    } else {
        inline_params(&request.sql, &request.params)?
    };
    let mut stream = sqlx::raw_sql(&sql).fetch(&mut **connection);
    let outcome = emit_chunks(
        futures_util::TryStreamExt::map_err(&mut stream, db_err),
        StreamConfig::new(request, &columns),
        decode_row,
        sink,
    )
    .await?;
    Ok(result::streamed(request, started, columns, &outcome, 0))
}

async fn statement_columns(
    connection: &mut PoolConnection<Postgres>,
    request: &QueryRequest,
    enums: &EnumLabels,
) -> Result<Vec<ColumnDefinition>, CoreError> {
    // Declare the parameters as the types `bound` encodes them with. Left to
    // inference, `id = $1` makes $1 an int4 and the int8 sent later is rejected.
    let types: Vec<PgTypeInfo> = request.params.iter().map(param_type).collect();
    let statement = connection.prepare_with(&request.sql, &types).await.map_err(db_err)?;
    let mut columns = column_defs(statement.columns());
    attach_enum_options(&mut columns, enums);
    Ok(columns)
}

fn param_type(param: &SqlValue) -> PgTypeInfo {
    match param {
        SqlValue::Null | SqlValue::Int(_) => <i64 as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Bool(_) => <bool as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Float(_) => <f64 as sqlx::Type<Postgres>>::type_info(),
        // Text goes into the query as a quoted literal, which PostgreSQL types from
        // its context: `id = '5'` compares as integer. Leaving the type unspecified
        // (OID 0) here lets the describe step infer it the same way.
        SqlValue::Text(_) => PgTypeInfo::with_oid(sqlx::postgres::types::Oid(0)),
        SqlValue::Bytes(_) => <&[u8] as sqlx::Type<Postgres>>::type_info(),
    }
}

fn decode_row(row: &PgRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_cell(row, index)).collect()
}

fn decode_cell(row: &PgRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    match (raw.format(), raw.as_bytes().map(std::str::from_utf8)) {
        (PgValueFormat::Text, Ok(Ok(text))) => decode_text(&type_name, text),
        // Reads always use the simple protocol, so binary values should not arrive here.
        _ => SqlValue::Text(format!("<{type_name}>")),
    }
}

/// A value in text format, as PostgreSQL's output function wrote it. Numbers and
/// booleans become typed values so the grid can align and edit them; everything
/// else is shown exactly as psql would show it.
fn decode_text(type_name: &str, text: &str) -> SqlValue {
    match type_name {
        "BOOL" => match text {
            "t" => SqlValue::Bool(true),
            "f" => SqlValue::Bool(false),
            _ => cap_text(text.to_owned()),
        },
        "INT2" | "INT4" | "INT8" | "OID" => {
            text.parse::<i64>().map_or_else(|_| cap_text(text.to_owned()), SqlValue::Int)
        }
        "FLOAT4" | "FLOAT8" => match text.parse::<f64>() {
            Ok(value) if value.is_finite() => SqlValue::Float(value),
            _ => SqlValue::Text(text.to_owned()),
        },
        "BYTEA" => match text.strip_prefix("\\x").and_then(hex_bytes) {
            Some(bytes) => cap_bytes(bytes),
            None => cap_text(text.to_owned()),
        },
        _ => cap_text(text.to_owned()),
    }
}

fn hex_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()).collect()
}

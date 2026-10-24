use std::time::Instant;

use futures_util::{StreamExt, TryStreamExt};
use sqlx::mysql::{MySqlDatabaseError, MySqlPool, MySqlRow};
use sqlx::pool::PoolConnection;
use sqlx::{Connection, Executor, MySql, Row, TypeInfo, ValueRef};

use super::literal::inline_params;
use crate::driver::ChunkSink;
use crate::drivers::common::decode::{cap_bytes, cap_text, column_defs, finite_f64};
use crate::drivers::common::stream::{emit_chunks, StreamConfig};
use crate::drivers::common::{db_err, result};
use crate::error::CoreError;
use crate::types::{ColumnDefinition, QueryRequest, QueryResult};
use crate::value::SqlValue;

/// `ER_UNSUPPORTED_PS`: the statement cannot run through the prepared protocol.
const ER_UNSUPPORTED_PS: u16 = 1295;

/// A connection kept between queries, with the thread id that cancels it.
pub(super) struct Pinned {
    pub connection: PoolConnection<MySql>,
    pub thread_id: u64,
}

impl Pinned {
    pub(super) async fn acquire(pool: &MySqlPool) -> Result<Self, CoreError> {
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let thread_id = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *connection)
            .await
            .map_err(db_err)?;
        Ok(Self { connection, thread_id })
    }
}

/// Asks the server to interrupt `thread_id`'s statement, from another connection.
pub(super) async fn kill_query(pool: &MySqlPool, thread_id: u64) {
    // `thread_id` is a number from CONNECTION_ID(), so formatting it is safe.
    let sql = format!("KILL QUERY {thread_id}");
    let _ = pool.execute(sql.as_str()).await;
}

/// Drains what a cancelled statement left behind. A `KILL QUERY` that lands
/// after the statement finished can interrupt the next one, so a single
/// interrupted probe is tolerated before the connection is given up.
pub(super) async fn resync(connection: &mut PoolConnection<MySql>) -> bool {
    for _ in 0..2 {
        if connection.execute("DO 0").await.is_ok() {
            return true;
        }
        if connection.ping().await.is_err() {
            return false;
        }
    }
    false
}

pub(super) async fn run(
    connection: &mut PoolConnection<MySql>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let described = statement_columns(connection, &request.sql).await?;
    // Reads go through the text protocol, like the mysql client: values arrive as
    // MySQL prints them (DATETIME(3) keeps .500), and statements the prepared
    // protocol rejects still run. Parameters are written in as literals.
    let sql = if request.params.is_empty() {
        request.sql.clone()
    } else {
        inline_params(&request.sql, &request.params)?
    };
    let mut stream = (&mut **connection).fetch_many(sql.as_str());

    let mut rows_affected = 0;
    let first = loop {
        if request.cancelled() {
            break None;
        }
        match stream.try_next().await.map_err(db_err)? {
            Some(sqlx::Either::Left(done)) => rows_affected += done.rows_affected(),
            Some(sqlx::Either::Right(row)) => break Some(row),
            None => break None,
        }
    };
    let columns = match (&first, described) {
        (_, Some(columns)) if !columns.is_empty() => columns,
        (Some(row), _) => column_defs(row.columns()),
        (None, _) => Vec::new(),
    };
    if columns.is_empty() {
        if request.cancelled() {
            return result::cancelled(sink, request, started).await;
        }
        return result::done(sink, request, started, rows_affected).await;
    }

    let rows = futures_util::stream::iter(first.map(Ok))
        .chain(stream.try_filter_map(|item| futures_util::future::ready(Ok(item.right()))));
    let outcome =
        emit_chunks(rows.map_err(db_err), StreamConfig::new(request, &columns), decode_row, sink)
            .await?;
    Ok(result::streamed(request, started, columns, &outcome, rows_affected))
}

/// Result columns from the prepared protocol, or `None` when the server
/// cannot prepare the statement and columns must come from the first row.
async fn statement_columns(
    connection: &mut PoolConnection<MySql>,
    sql: &str,
) -> Result<Option<Vec<ColumnDefinition>>, CoreError> {
    match (&mut **connection).describe(sql).await {
        Ok(describe) => Ok(Some(column_defs(describe.columns()))),
        Err(err) if is_unsupported_ps(&err) => Ok(None),
        Err(err) => Err(db_err(err)),
    }
}

pub(super) fn is_unsupported_ps(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|db| db.try_downcast_ref::<MySqlDatabaseError>())
        .is_some_and(|db| db.number() == ER_UNSUPPORTED_PS)
}

fn decode_row(row: &MySqlRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_cell(row, index)).collect()
}

/// Decodes one cell of a text-protocol row.
fn decode_cell(row: &MySqlRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    let decoded = match type_name.as_str() {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
            row.try_get_unchecked::<i64, _>(index).ok().map(SqlValue::Int)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" | "YEAR" | "BIT" => {
            row.try_get_unchecked::<u64, _>(index).ok().map(|value| match i64::try_from(value) {
                Ok(value) => SqlValue::Int(value),
                Err(_) => SqlValue::Text(value.to_string()),
            })
        }
        "FLOAT" => {
            row.try_get_unchecked::<f32, _>(index).ok().map(|value| finite_f64(f64::from(value)))
        }
        "DOUBLE" => row.try_get_unchecked::<f64, _>(index).ok().map(finite_f64),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            row.try_get_unchecked::<Vec<u8>, _>(index).ok().map(bytes_or_text)
        }
        "GEOMETRY" => row.try_get_unchecked::<Vec<u8>, _>(index).ok().map(cap_bytes),
        _ => None,
    };
    if let Some(value) = decoded {
        return value;
    }
    // DECIMAL, JSON, temporal text, and character types all arrive as text.
    if let Ok(value) = row.try_get_unchecked::<String, _>(index) {
        return cap_text(value);
    }
    if let Ok(value) = row.try_get_unchecked::<Vec<u8>, _>(index) {
        return cap_bytes(value);
    }
    SqlValue::Text(format!("<{type_name}>"))
}

/// The protocol flags `_bin` collations (and MariaDB's JSON) like binary
/// strings, and the charset that tells them apart is not exposed. Readable
/// UTF-8 is shown as text; anything else stays bytes.
fn bytes_or_text(bytes: Vec<u8>) -> SqlValue {
    match String::from_utf8(bytes) {
        Ok(text) if !text.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) => {
            cap_text(text)
        }
        Ok(text) => cap_bytes(text.into_bytes()),
        Err(err) => cap_bytes(err.into_bytes()),
    }
}

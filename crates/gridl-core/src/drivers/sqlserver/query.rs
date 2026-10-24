use std::time::Instant;

use futures_util::TryStreamExt;
use tiberius::{ColumnType, Query, QueryItem, QueryStream};

use super::connect::server_err;
use super::decode::decode_row;
use super::lexer::{counts_rows, number_params, split_batches};
use super::MsClient;
use crate::driver::ChunkSink;
use crate::drivers::common::result;
use crate::drivers::common::stream::{emit_chunks, StreamConfig, StreamOutcome};
use crate::error::CoreError;
use crate::types::{ColumnDefinition, QueryRequest, QueryResult};
use crate::value::SqlValue;

/// Runs every batch of the editor's SQL (split on `GO` lines, like sqlcmd and
/// SSMS) and streams the first result set any of them returns.
pub(super) async fn run(
    client: &mut MsClient,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let mut params = request.params.as_slice();
    let mut rows_affected = 0;
    let mut shown: Option<(Vec<ColumnDefinition>, StreamOutcome)> = None;
    for batch in split_batches(&request.sql) {
        if request.cancelled() {
            break;
        }
        let (sql, used) = number_params(batch, params)?;
        let (bound, rest) = params.split_at(used);
        params = rest;
        if counts_rows(batch) {
            // Only the RPC path reports how many rows a statement changed.
            let mut query = Query::new(sql);
            bind_all(&mut query, bound);
            rows_affected += query.execute(&mut *client).await.map_err(server_err)?.total();
            continue;
        }
        let mut stream = if bound.is_empty() {
            client.simple_query(sql).await.map_err(server_err)?
        } else {
            let mut query = Query::new(sql);
            bind_all(&mut query, bound);
            query.query(&mut *client).await.map_err(server_err)?
        };
        let columns = stream.columns().await.map_err(server_err)?.map(column_defs);
        let (Some(columns), None) = (columns, &shown) else {
            drain(stream).await?;
            continue;
        };
        let outcome = stream_first_result(&mut stream, request, &columns, sink).await?;
        if outcome.cancelled || outcome.truncated {
            // The caller tells the server to stop sending the rest.
            return Ok(result::streamed(request, started, columns, &outcome, rows_affected));
        }
        // Later statements of the batch still run; their errors still count.
        drain(stream).await?;
        shown = Some((columns, outcome));
    }
    match shown {
        Some((columns, outcome)) => {
            Ok(result::streamed(request, started, columns, &outcome, rows_affected))
        }
        None if request.cancelled() => result::cancelled(sink, request, started).await,
        None => result::done(sink, request, started, rows_affected).await,
    }
}

/// Streams the rows of the result set `stream` is on, up to the next one.
async fn stream_first_result(
    stream: &mut QueryStream<'_>,
    request: &QueryRequest,
    columns: &[ColumnDefinition],
    sink: &mut dyn ChunkSink,
) -> Result<StreamOutcome, CoreError> {
    let rows = stream
        .map_err(server_err)
        .try_take_while(|item| futures_util::future::ready(Ok(!is_next_result(item))))
        .try_filter_map(|item| futures_util::future::ready(Ok(item.into_row())));
    futures_util::pin_mut!(rows);
    emit_chunks(rows, StreamConfig::new(request, columns), decode_row, sink).await
}

/// True for the metadata that opens the second result set; the first one's
/// metadata was already read through `columns()`.
fn is_next_result(item: &QueryItem) -> bool {
    matches!(item, QueryItem::Metadata(meta) if meta.result_index() > 0)
}

async fn drain(mut stream: QueryStream<'_>) -> Result<(), CoreError> {
    while stream.try_next().await.map_err(server_err)?.is_some() {}
    Ok(())
}

pub(super) fn bind_all<'a>(query: &mut Query<'a>, params: &'a [SqlValue]) {
    for param in params {
        match param {
            SqlValue::Null => query.bind(Option::<&str>::None),
            SqlValue::Bool(value) => query.bind(*value),
            SqlValue::Int(value) => query.bind(*value),
            SqlValue::Float(value) => query.bind(*value),
            SqlValue::Text(value) => query.bind(value.as_str()),
            SqlValue::Bytes(value) => query.bind(value.as_slice()),
        }
    }
}

fn column_defs(columns: &[tiberius::Column]) -> Vec<ColumnDefinition> {
    columns
        .iter()
        .map(|column| ColumnDefinition {
            name: column.name().to_owned(),
            data_type: type_name(column.column_type()).to_owned(),
            nullable: true,
            primary_key: false,
            default_value: None,
            options: Vec::new(),
            mode: None,
        })
        .collect()
}

fn type_name(column_type: ColumnType) -> &'static str {
    match column_type {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Intn => "int",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln | ColumnType::Numericn => "decimal",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::Text => "text",
        ColumnType::Image => "image",
        ColumnType::NText => "ntext",
        ColumnType::SSVariant => "sql_variant",
    }
}

/// 1-based character offset of the start of `line` (1-based) in `sql`.
pub(super) fn line_offset(sql: &str, line: u32) -> Option<u32> {
    if line <= 1 {
        return Some(1);
    }
    let mut offset: u32 = 1;
    let mut current = 1;
    for c in sql.chars() {
        offset += 1;
        if c == '\n' {
            current += 1;
            if current == line {
                return Some(offset);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_lines_point_into_the_statement() {
        assert_eq!(line_offset("select\nfrom", 2), Some(8));
        assert_eq!(line_offset("select", 1), Some(1));
        assert_eq!(line_offset("select", 3), None);
    }
}

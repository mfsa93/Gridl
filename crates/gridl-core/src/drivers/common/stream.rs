use std::sync::atomic::Ordering;

use futures_util::TryStreamExt;

use crate::driver::ChunkSink;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, QueryRequest, RowChunk};
use crate::value::SqlValue;

pub(crate) struct StreamOutcome {
    pub row_count: u64,
    pub cancelled: bool,
    pub truncated: bool,
}

pub(crate) struct StreamConfig<'a> {
    pub query_id: &'a str,
    pub columns: &'a [ColumnDefinition],
    pub chunk_rows: usize,
    pub max_rows: u64,
    pub cancel: &'a std::sync::atomic::AtomicBool,
}

impl<'a> StreamConfig<'a> {
    /// Chunk size, row limit and cancel flag from `request`.
    pub(crate) fn new(request: &'a QueryRequest, columns: &'a [ColumnDefinition]) -> Self {
        Self {
            query_id: &request.query_id,
            columns,
            chunk_rows: request.chunk_rows,
            max_rows: request.max_rows,
            cancel: &request.cancel,
        }
    }
}

/// Pull a row stream into fixed-size chunks. The first chunk carries columns.
pub(crate) async fn emit_chunks<R, S, F>(
    mut stream: S,
    config: StreamConfig<'_>,
    mut decode_row: F,
    sink: &mut dyn ChunkSink,
) -> Result<StreamOutcome, CoreError>
where
    S: futures_util::Stream<Item = Result<R, CoreError>> + Unpin,
    F: FnMut(&R) -> Vec<SqlValue>,
{
    let mut buffer = Vec::with_capacity(config.chunk_rows);
    let mut index: u32 = 0;
    let mut row_count: u64 = 0;

    loop {
        if config.cancel.load(Ordering::Relaxed) {
            emit(sink, &config, index, buffer, true).await?;
            return Ok(StreamOutcome { row_count, cancelled: true, truncated: false });
        }

        match stream.try_next().await? {
            Some(row) => {
                if row_count == config.max_rows {
                    emit(sink, &config, index, buffer, true).await?;
                    return Ok(StreamOutcome { row_count, cancelled: false, truncated: true });
                }
                buffer.push(decode_row(&row));
                row_count += 1;
                if buffer.len() >= config.chunk_rows {
                    emit(sink, &config, index, std::mem::take(&mut buffer), false).await?;
                    buffer.reserve(config.chunk_rows);
                    index = index.saturating_add(1);
                }
            }
            None => {
                emit(sink, &config, index, buffer, true).await?;
                return Ok(StreamOutcome { row_count, cancelled: false, truncated: false });
            }
        }
    }
}

async fn emit(
    sink: &mut dyn ChunkSink,
    config: &StreamConfig<'_>,
    index: u32,
    rows: Vec<Vec<SqlValue>>,
    last: bool,
) -> Result<(), CoreError> {
    sink.on_chunk(RowChunk {
        query_id: config.query_id.to_owned(),
        index,
        columns: if index == 0 { config.columns.to_vec() } else { Vec::new() },
        rows,
        last,
    })
    .await
}

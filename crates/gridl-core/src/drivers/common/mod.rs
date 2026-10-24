//! What every driver shares. A driver keeps only what is specific to its
//! engine: how to connect, what its catalog looks like, how it runs a
//! statement and how it decodes a value.
//!
//! - [`session`]: the open sessions by connection id, and the two connections
//!   (editor and table browser) each session keeps.
//! - [`cancel`]: stopping a running statement when the user cancels.
//! - [`result`]: the [`crate::QueryResult`] and the closing chunk of a query.
//! - [`stream`]: rows to chunks, without holding the whole result.
//! - [`decode`]: limits for one cell.
//! - [`bind`]: parameters for the sqlx drivers.
//! - [`catalog`]: building schemas from catalog rows.
//! - [`tools`]: the engines' command line tools, for backups and restores.

pub(crate) mod bind;
pub(crate) mod cancel;
pub(crate) mod catalog;
pub(crate) mod decode;
pub(crate) mod result;
pub(crate) mod session;
pub(crate) mod stream;
pub(crate) mod tools;

use crate::error::CoreError;

pub(crate) fn db_err(err: sqlx::Error) -> CoreError {
    CoreError::Database(err.to_string())
}

/// Statement `index` (from 0) of a batch failed.
pub(crate) fn batch_err(index: usize, err: &sqlx::Error) -> CoreError {
    CoreError::Statement { number: index + 1, message: err.to_string() }
}

pub(crate) fn elapsed_ms(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

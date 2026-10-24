//! The Tauri commands the frontend calls, grouped by what they act on. Each
//! command is a thin adapter: it turns IPC arguments into `gridl-core` calls
//! and errors into the strings the UI shows.
//!
//! - [`profiles`]: saved connections and groups.
//! - [`session`]: opening, testing and closing connections.
//! - [`catalog`]: the schema of an open connection.
//! - [`query`]: running SQL, batches, cancellation and time limits.
//! - [`guard`]: the safety policy every statement passes through.
//! - [`export`]: writing exported rows to a file.
//! - [`window`]: unsaved edits and closing windows.

pub(crate) mod catalog;
pub(crate) mod export;
pub(crate) mod guard;
pub(crate) mod profiles;
pub(crate) mod query;
pub(crate) mod session;
pub(crate) mod window;

use std::time::Instant;

use gridl_core::CoreError;

/// A core error as the message the UI shows.
pub(crate) fn fail(err: CoreError) -> String {
    err.to_string()
}

pub(crate) fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

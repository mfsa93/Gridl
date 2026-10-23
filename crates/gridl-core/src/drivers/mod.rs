mod decode;
mod mysql;
mod postgres;
mod sqlite;
mod stream;

pub use mysql::MysqlDriver;
pub use postgres::PostgresDriver;
pub use sqlite::SqliteDriver;

use crate::error::CoreError;

pub(crate) fn db_err(err: sqlx::Error) -> CoreError {
    CoreError::Database(err.to_string())
}

pub(crate) fn batch_err(index: usize, err: &sqlx::Error) -> CoreError {
    CoreError::Database(format!("sentencia {}: {err}", index + 1))
}

pub(crate) fn quote_ident(name: &str) -> Result<String, CoreError> {
    if name.is_empty() || name.len() > 1024 || name.contains('\0') {
        return Err(CoreError::InvalidConfig("identifier must be 1..=1024 characters".into()));
    }
    Ok(format!("\"{}\"", name.replace('"', "\"\"")))
}

pub(crate) fn elapsed_ms(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

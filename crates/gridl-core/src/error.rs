use std::io;

use crate::tr;

fn statement_failed(number: usize, message: &str) -> String {
    tr!("statement {number}: {message}", "sentencia {number}: {message}")
}

/// Recoverable failure from a port or a driver.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("connection '{0}' is not open")]
    NotConnected(String),
    #[error("invalid connection config: {0}")]
    InvalidConfig(String),
    #[error("query was cancelled")]
    Cancelled,
    #[error("database: {0}")]
    Database(String),
    /// Statement `number` (from 1) of a batch failed; the batch was rolled back.
    #[error("database: {}", statement_failed(*number, message))]
    Statement { number: usize, message: String },
    #[error("credential store: {0}")]
    Credential(String),
    #[error("invalid profile file: {0}")]
    Profile(String),
    #[error("failed to deliver row chunk: {0}")]
    Delivery(String),
    #[error("lock poisoned")]
    LockPoisoned,
    /// Import, export, backup, or restore problem, already worded for the user.
    #[error("{0}")]
    Transfer(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

#[cfg(test)]
mod tests {
    use super::CoreError;
    use crate::{with_locale, Locale};

    #[test]
    fn statement_errors_name_the_statement_in_both_languages() {
        let err = CoreError::Statement { number: 2, message: "duplicate key".into() };
        assert_eq!(
            with_locale(Locale::En, || err.to_string()),
            "database: statement 2: duplicate key"
        );
        assert_eq!(
            with_locale(Locale::Es, || err.to_string()),
            "database: sentencia 2: duplicate key"
        );
    }
}

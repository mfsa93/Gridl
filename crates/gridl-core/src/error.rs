use std::io;

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
    #[error("credential store: {0}")]
    Credential(String),
    #[error("invalid profile file: {0}")]
    Profile(String),
    #[error("failed to deliver row chunk: {0}")]
    Delivery(String),
    #[error("lock poisoned")]
    LockPoisoned,
    #[error("internal error: {0}")]
    Internal(String),
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

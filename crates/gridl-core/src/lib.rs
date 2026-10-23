//! Gridl core is the database port of the desktop client.
//!
//! It has no dependency on Tauri. The desktop shell adapts operating-system
//! credentials and IPC to the traits defined here, and each engine implements
//! [`DatabaseDriver`].

mod driver;
mod drivers;
mod error;
mod guard;
mod profiles;
mod secret;
mod types;
mod value;
mod vault;

pub use driver::{ChunkSink, DatabaseDriver};
pub use drivers::{MysqlDriver, PostgresDriver, SqliteDriver};
pub use error::CoreError;
pub use guard::{
    classify, evaluate, Environment, GuardMode, SafetySettings, StatementKind, Verdict,
};
pub use profiles::{
    add_group, load_catalog, load_profiles, remove_group, store_catalog, store_profiles,
    upsert_profile, ConnectionCatalog,
};
pub use secret::SecretString;
pub use types::{
    BatchRequest, BatchResult, BatchStatement, ColumnDefinition, ConnectionConfig, ConnectionId,
    DatabaseEngine, ForeignKey, QueryRequest, QueryResult, RelationKind, RelationRef, RowChunk,
    SqlCheck, SqlProblem, SshAuth, SshSettings, TableSchema, TlsMode, TlsSettings,
    DEFAULT_CHUNK_ROWS, MAX_BATCH_STATEMENTS, MAX_CHUNK_ROWS, MAX_SQL_BYTES, MAX_STREAM_ROWS,
};
pub use value::SqlValue;
pub use vault::{CredentialVault, MemoryVault};

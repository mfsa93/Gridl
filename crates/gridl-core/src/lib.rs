//! Gridl core is the database port of the desktop client.
//!
//! It has no dependency on Tauri. The desktop shell adapts operating-system
//! credentials and IPC to the traits defined here, and each engine implements
//! [`DatabaseDriver`].

mod driver;
mod drivers;
mod engines;
mod error;
mod export;
mod guard;
mod i18n;
mod import;
mod profiles;
mod secret;
mod types;
mod value;
mod vault;

pub use driver::{ChunkSink, DatabaseDriver, ToolAccess};
pub use drivers::{builtin_drivers, MysqlDriver, PostgresDriver, SqliteDriver, SqlserverDriver};
pub use engines::{
    builtin_specs, spec as engine_spec, BackupTool, BooleanLiteral, BytesLiteral, EngineSpec,
};
pub use error::CoreError;
pub use export::{js_number, quote_ident, sql_literal, text_literal, ExportFormat, ExportWriter};
pub use guard::{
    classify, evaluate, evaluate_restore, Environment, GuardMode, SafetySettings, StatementKind,
    Verdict,
};
pub use i18n::{detect as detect_locale, locale, set_locale, with_locale, Locale};
pub use import::{
    build_import, parse_delimiter, preview_csv, sniff_delimiter, CsvPreview, ImportBatch,
    ImportPlan, IMPORT_ROWS_PER_STATEMENT, MAX_IMPORT_BYTES,
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
    DEFAULT_CHUNK_ROWS, MAX_BATCH_STATEMENTS, MAX_BULK_BYTES, MAX_CHUNK_ROWS, MAX_SQL_BYTES,
    MAX_STREAM_ROWS,
};
pub use value::SqlValue;
pub use vault::{CredentialVault, MemoryVault};

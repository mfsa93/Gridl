use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::guard::SafetySettings;
use crate::value::SqlValue;

/// Rows delivered to the UI in one IPC message.
pub const DEFAULT_CHUNK_ROWS: usize = 500;
/// Upper bound for a single chunk. Larger values risk stalling the webview.
pub const MAX_CHUNK_ROWS: usize = 5_000;
/// Hard cap on a statement so a pasted file cannot exhaust memory before execution.
pub const MAX_SQL_BYTES: usize = 2 * 1024 * 1024;
/// Safety cap for a single streamed result. The grid virtualizes rendering;
/// this cap stops an unbounded result from exhausting process memory.
pub const MAX_STREAM_ROWS: u64 = 1_000_000;

/// Engine selected by a saved connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    Sqlite,
    Postgres,
    Mysql,
}

/// Opaque id of an open session. Sessions are keyed by [`ConnectionConfig::id`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnectionId(String);

impl ConnectionId {
    pub fn new(id: impl Into<String>) -> Result<Self, CoreError> {
        let id = id.into();
        validate_token(&id, "connection id")?;
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ConnectionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// How PostgreSQL or MySQL negotiates TLS. Paths stay on disk; key material is not stored here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    #[default]
    Prefer,
    Disable,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Certificate files for a PostgreSQL or MySQL connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TlsSettings {
    #[serde(default)]
    pub mode: TlsMode,
    #[serde(default)]
    pub root_cert: Option<String>,
    #[serde(default)]
    pub client_cert: Option<String>,
    #[serde(default)]
    pub client_key: Option<String>,
}

/// SSH authentication for a tunnel. The password or key passphrase lives in the keyring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    #[default]
    Key,
}

/// SSH local forward. The private key stays in a file on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub auth: SshAuth,
    #[serde(default)]
    pub private_key: Option<String>,
    /// SHA256 fingerprint accepted for this SSH server.
    #[serde(default)]
    pub host_fingerprint: Option<String>,
    /// Keyring account for the SSH password or the key passphrase.
    #[serde(default)]
    pub credential_account: Option<String>,
}

/// Saved connection. The password is never a field of this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub engine: DatabaseEngine,
    /// Filesystem path for SQLite, database name for PostgreSQL and MySQL.
    pub database: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// Account name in the OS credential store. The secret itself is not here.
    pub credential_account: Option<String>,
    /// Folder name on the connection screen. Empty means ungrouped.
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub create_if_missing: bool,
    #[serde(default)]
    pub tls: TlsSettings,
    #[serde(default)]
    pub ssh: SshSettings,
    /// Environment and which statements need authorization or are blocked.
    #[serde(default)]
    pub safety: SafetySettings,
}

impl ConnectionConfig {
    pub fn validate(&self) -> Result<(), CoreError> {
        let _id = self.connection_id()?;
        if self.name.trim().is_empty() || self.name.len() > 200 {
            return Err(CoreError::InvalidConfig("name must be 1..=200 characters".into()));
        }
        if self.database.trim().is_empty() {
            return Err(CoreError::InvalidConfig("database is empty".into()));
        }
        if let Some(host) = &self.host {
            if host.trim().is_empty() || host.chars().any(char::is_control) {
                return Err(CoreError::InvalidConfig("host is invalid".into()));
            }
        }
        if let Some(username) = &self.username {
            if username.is_empty() || username.len() > 200 {
                return Err(CoreError::InvalidConfig("username is invalid".into()));
            }
        }
        if let Some(account) = &self.credential_account {
            validate_token(account, "credential account")?;
        }
        if let Some(group) = &self.group {
            validate_group_name(group)?;
        }
        self.validate_security()?;
        Ok(())
    }

    /// Trims the name, group, and security paths, then validates.
    pub fn prepare(mut self) -> Result<Self, CoreError> {
        self.name = self.name.trim().to_owned();
        self.group = trim_opt(self.group);
        self.tls.root_cert = trim_opt(self.tls.root_cert);
        self.tls.client_cert = trim_opt(self.tls.client_cert);
        self.tls.client_key = trim_opt(self.tls.client_key);
        self.ssh.host = trim_opt(self.ssh.host);
        self.ssh.username = trim_opt(self.ssh.username);
        self.ssh.private_key = trim_opt(self.ssh.private_key);
        self.ssh.host_fingerprint = trim_opt(self.ssh.host_fingerprint);
        self.ssh.credential_account = trim_opt(self.ssh.credential_account);
        self.validate()?;
        Ok(self)
    }

    fn validate_security(&self) -> Result<(), CoreError> {
        if !matches!(self.engine, DatabaseEngine::Postgres | DatabaseEngine::Mysql) {
            return Ok(());
        }
        validate_path_opt(self.tls.root_cert.as_deref(), "certificado CA")?;
        validate_path_opt(self.tls.client_cert.as_deref(), "certificado cliente")?;
        validate_path_opt(self.tls.client_key.as_deref(), "llave cliente")?;
        if self.tls.client_cert.is_some() != self.tls.client_key.is_some() {
            return Err(CoreError::InvalidConfig(
                "el certificado cliente y su llave van juntos".into(),
            ));
        }
        if matches!(self.tls.mode, TlsMode::VerifyCa | TlsMode::VerifyFull)
            && self.tls.root_cert.is_none()
        {
            return Err(CoreError::InvalidConfig(
                "verificar el certificado exige un certificado CA".into(),
            ));
        }
        if !self.ssh.enabled {
            return Ok(());
        }
        validate_host(self.ssh.host.as_deref(), "servidor SSH")?;
        let username = self.ssh.username.as_deref().unwrap_or("");
        if username.is_empty() || username.len() > 200 || username.chars().any(char::is_control) {
            return Err(CoreError::InvalidConfig("el usuario SSH no es válido".into()));
        }
        if self.ssh.port == Some(0) {
            return Err(CoreError::InvalidConfig("el puerto SSH no es válido".into()));
        }
        if self.ssh.auth == SshAuth::Key {
            validate_path_opt(self.ssh.private_key.as_deref(), "llave privada")?;
            if self.ssh.private_key.is_none() {
                return Err(CoreError::InvalidConfig("indica la ruta de la llave privada".into()));
            }
        }
        if let Some(fingerprint) = &self.ssh.host_fingerprint {
            if fingerprint.len() > 200 || fingerprint.chars().any(char::is_control) {
                return Err(CoreError::InvalidConfig("la huella SSH no es válida".into()));
            }
        }
        if let Some(account) = &self.ssh.credential_account {
            validate_token(account, "credential account")?;
        }
        Ok(())
    }

    pub fn connection_id(&self) -> Result<ConnectionId, CoreError> {
        ConnectionId::new(self.id.clone())
    }
}

/// Column metadata, either from a catalog or from a result set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefinition {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    /// Closed set of values, such as the labels of a PostgreSQL enum.
    #[serde(default)]
    pub options: Vec<String>,
}

/// Table, view, routine, or other catalog object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationKind {
    Table,
    View,
    Materialized,
    Function,
    Procedure,
    Sequence,
    Trigger,
    Index,
}

/// Pointer to a relation, without its columns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: Option<String>,
    pub name: String,
    pub kind: RelationKind,
}

/// Catalog description of one relation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub schema: Option<String>,
    pub name: String,
    pub kind: RelationKind,
    pub columns: Vec<ColumnDefinition>,
    /// Source of a routine, trigger, index, or view when the catalog provides it.
    #[serde(default)]
    pub definition: Option<String>,
}

/// One IPC block of a streaming query.
///
/// `columns` is filled only when `index == 0`. Later chunks omit it so a
/// 100k-row result does not repeat the header on every message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChunk {
    pub query_id: String,
    pub index: u32,
    pub columns: Vec<ColumnDefinition>,
    pub rows: Vec<Vec<SqlValue>>,
    pub last: bool,
}

/// Summary returned after the last chunk has been delivered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub query_id: String,
    pub columns: Vec<ColumnDefinition>,
    pub row_count: u64,
    pub rows_affected: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub truncated: bool,
}

/// Owned query handed to a driver. It is not serialized over IPC.
pub struct QueryRequest {
    pub query_id: String,
    pub sql: String,
    pub params: Vec<SqlValue>,
    pub chunk_rows: usize,
    pub max_rows: u64,
    pub cancel: Arc<AtomicBool>,
}

impl QueryRequest {
    pub fn new(
        query_id: impl Into<String>,
        sql: impl Into<String>,
        params: Vec<SqlValue>,
        chunk_rows: usize,
        max_rows: u64,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, CoreError> {
        let query_id = query_id.into();
        let sql = sql.into();
        validate_token(&query_id, "query id")?;
        if sql.trim().is_empty() {
            return Err(CoreError::InvalidConfig("SQL is empty".into()));
        }
        if sql.len() > MAX_SQL_BYTES {
            return Err(CoreError::InvalidConfig("SQL exceeds 2 MiB".into()));
        }
        if chunk_rows == 0 || chunk_rows > MAX_CHUNK_ROWS {
            return Err(CoreError::InvalidConfig(format!(
                "chunk size must be 1..={MAX_CHUNK_ROWS}"
            )));
        }
        if max_rows == 0 || max_rows > MAX_STREAM_ROWS {
            return Err(CoreError::InvalidConfig(format!(
                "max rows must be 1..={MAX_STREAM_ROWS}"
            )));
        }
        Ok(Self { query_id, sql, params, chunk_rows, max_rows, cancel })
    }

    /// A query whose rows go to a file instead of the grid. It has no row cap,
    /// because the sink writes each chunk out and keeps nothing in memory.
    pub fn export(
        query_id: impl Into<String>,
        sql: impl Into<String>,
        chunk_rows: usize,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, CoreError> {
        let mut request = Self::new(query_id, sql, Vec::new(), chunk_rows, 1, cancel)?;
        request.max_rows = u64::MAX;
        Ok(request)
    }
}

/// A foreign key: `columns` of `schema.table` point at `ref_columns` of the referenced table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    /// Empty when the database leaves it implicit (SQLite referencing the primary key).
    pub ref_columns: Vec<String>,
    /// `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, or `SET DEFAULT`.
    pub on_update: String,
    pub on_delete: String,
}

/// First problem the database reports when it parses a statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlProblem {
    pub message: String,
    /// 1-based character offset into the statement, when the server reports one.
    pub position: Option<u32>,
    pub code: Option<String>,
}

/// Outcome of parsing a statement without running it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCheck {
    /// False when the server cannot say, for example for statements it cannot prepare.
    pub checked: bool,
    pub problem: Option<SqlProblem>,
}

impl SqlCheck {
    pub fn clean() -> Self {
        Self { checked: true, problem: None }
    }

    pub fn unknown() -> Self {
        Self { checked: false, problem: None }
    }

    pub fn failed(problem: SqlProblem) -> Self {
        Self { checked: true, problem: Some(problem) }
    }
}

/// Upper bound for statements applied together in one transaction.
pub const MAX_BATCH_STATEMENTS: usize = 10_000;

/// One parameterized statement of a [`BatchRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<SqlValue>,
}

/// Statements that commit together or not at all.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchRequest {
    pub statements: Vec<BatchStatement>,
}

impl BatchRequest {
    pub fn new(statements: Vec<BatchStatement>) -> Result<Self, CoreError> {
        if statements.is_empty() {
            return Err(CoreError::InvalidConfig("batch is empty".into()));
        }
        if statements.len() > MAX_BATCH_STATEMENTS {
            return Err(CoreError::InvalidConfig(format!(
                "batch exceeds {MAX_BATCH_STATEMENTS} statements"
            )));
        }
        let total: usize = statements.iter().map(|statement| statement.sql.len()).sum();
        if total > MAX_SQL_BYTES * 8 {
            return Err(CoreError::InvalidConfig("batch exceeds 16 MiB".into()));
        }
        if statements.iter().any(|statement| statement.sql.trim().is_empty()) {
            return Err(CoreError::InvalidConfig("SQL is empty".into()));
        }
        Ok(Self { statements })
    }

    /// A large batch built by the app itself, such as a CSV import. It skips
    /// the statement count cap and allows up to [`MAX_BULK_BYTES`] of SQL.
    pub fn bulk(statements: Vec<BatchStatement>) -> Result<Self, CoreError> {
        if statements.is_empty() {
            return Err(CoreError::InvalidConfig("batch is empty".into()));
        }
        let total: usize = statements.iter().map(|statement| statement.sql.len()).sum();
        if total > MAX_BULK_BYTES {
            return Err(CoreError::InvalidConfig("batch exceeds 1 GiB".into()));
        }
        Ok(Self { statements })
    }
}

/// Upper bound for the SQL of one [`BatchRequest::bulk`].
pub const MAX_BULK_BYTES: usize = 1024 * 1024 * 1024;

/// Summary of a committed [`BatchRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub statements: u64,
    pub rows_affected: u64,
    pub duration_ms: u64,
}

fn trim_opt(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn validate_host(host: Option<&str>, label: &str) -> Result<(), CoreError> {
    let host = host.unwrap_or("");
    if host.is_empty() || host.len() > 255 || host.chars().any(char::is_control) {
        return Err(CoreError::InvalidConfig(format!("el {label} no es válido")));
    }
    Ok(())
}

fn validate_path_opt(path: Option<&str>, label: &str) -> Result<(), CoreError> {
    let Some(path) = path else {
        return Ok(());
    };
    if path.is_empty() || path.len() > 1024 || path.chars().any(char::is_control) {
        return Err(CoreError::InvalidConfig(format!("la ruta de {label} no es válida")));
    }
    Ok(())
}

pub(crate) fn validate_group_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        return Err(CoreError::InvalidConfig("group must be 1..=80 characters".into()));
    }
    Ok(())
}

pub(crate) fn validate_token(value: &str, label: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(CoreError::InvalidConfig(format!(
            "{label} must be 1..=128 characters without whitespace"
        )));
    }
    Ok(())
}

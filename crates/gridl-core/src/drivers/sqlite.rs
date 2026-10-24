use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Arguments, Connection, Executor, Row, Sqlite, Statement, TypeInfo, ValueRef};

use super::decode::{cap_bytes, cap_text, column_defs, finite_f64};
use super::stream::{emit_chunks, StreamConfig};
use super::{batch_err, db_err, elapsed_ms, quote_ident};
use crate::driver::{ChunkSink, DatabaseDriver};
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::ForeignKey;
use crate::types::{
    BatchRequest, BatchResult, ColumnDefinition, ConnectionConfig, ConnectionId, DatabaseEngine,
    QueryRequest, QueryResult, RelationKind, RelationRef, RowChunk, SqlCheck, SqlProblem,
    TableSchema,
};
use crate::value::SqlValue;

/// One open database: a pool for catalog reads and batches, plus the
/// connection the editor keeps so transactions span several queries.
struct Session {
    pool: SqlitePool,
    editor: tokio::sync::Mutex<Option<PoolConnection<Sqlite>>>,
}

/// SQLite adapter. Each connection id owns one pool.
pub struct SqliteDriver {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self { sessions: RwLock::new(HashMap::new()) }
    }

    fn session(&self, id: &ConnectionId) -> Result<Arc<Session>, CoreError> {
        let sessions = self.sessions.read().map_err(|_| CoreError::LockPoisoned)?;
        sessions
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| CoreError::NotConnected(id.as_str().to_owned()))
    }

    fn pool(&self, id: &ConnectionId) -> Result<SqlitePool, CoreError> {
        Ok(self.session(id)?.pool.clone())
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Sqlite
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        _password: Option<&SecretString>,
        _endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        config.validate()?;
        if config.engine != DatabaseEngine::Sqlite {
            return Err(CoreError::InvalidConfig(
                "sqlite driver received a non-sqlite connection".into(),
            ));
        }
        let path = resolve_sqlite_path(config)?;
        let options = connect_options(config, &path)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(options)
            .await
            .map_err(db_err)?;
        let id = config.connection_id()?;
        let session = Arc::new(Session { pool, editor: tokio::sync::Mutex::new(None) });
        let replaced = {
            let mut sessions = self.sessions.write().map_err(|_| CoreError::LockPoisoned)?;
            sessions.insert(id.as_str().to_owned(), session)
        };
        if let Some(previous) = replaced {
            close_session(&previous).await;
        }
        Ok(())
    }

    async fn probe(
        &self,
        config: &ConnectionConfig,
        _password: Option<&SecretString>,
        _endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        config.validate()?;
        if config.engine != DatabaseEngine::Sqlite {
            return Err(CoreError::InvalidConfig(
                "sqlite driver received a non-sqlite connection".into(),
            ));
        }
        let path = resolve_sqlite_path(config)?;
        let options = connect_options(config, &path)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(options)
            .await
            .map_err(db_err)?;
        let version: String =
            sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await.map_err(db_err)?;
        pool.close().await;
        Ok(version)
    }

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError> {
        let pool = {
            let mut sessions = self.sessions.write().map_err(|_| CoreError::LockPoisoned)?;
            sessions.remove(id.as_str())
        };
        let Some(session) = pool else {
            return Err(CoreError::NotConnected(id.as_str().to_owned()));
        };
        close_session(&session).await;
        Ok(())
    }

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError> {
        let pool = self.pool(id)?;
        let rows = sqlx::query(
            "SELECT name, type
             FROM sqlite_master
             WHERE type IN ('table', 'view', 'index', 'trigger')
               AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;
        rows.iter()
            .map(|row| {
                let name: String = row.try_get("name").map_err(db_err)?;
                let kind: String = row.try_get("type").map_err(db_err)?;
                Ok(RelationRef {
                    schema: None,
                    name,
                    kind: match kind.as_str() {
                        "view" => RelationKind::View,
                        "index" => RelationKind::Index,
                        "trigger" => RelationKind::Trigger,
                        _ => RelationKind::Table,
                    },
                })
            })
            .collect()
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        if relation.schema.as_deref().is_some_and(|schema| schema != "main") {
            return Err(CoreError::InvalidConfig(
                "sqlite attached databases are not supported yet".into(),
            ));
        }
        let pool = self.pool(id)?;
        if matches!(relation.kind, RelationKind::Index | RelationKind::Trigger) {
            let definition: Option<String> =
                sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = ?1")
                    .bind(&relation.name)
                    .fetch_optional(&pool)
                    .await
                    .map_err(db_err)?;
            return Ok(TableSchema {
                schema: None,
                name: relation.name.clone(),
                kind: relation.kind,
                columns: Vec::new(),
                definition,
                returns: None,
            });
        }
        let columns = table_info(&pool, &relation.name).await?;
        Ok(TableSchema {
            schema: relation.schema.clone(),
            name: relation.name.clone(),
            kind: relation.kind,
            columns,
            definition: None,
            returns: None,
        })
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        let relations = self.list_relations(id).await?;
        let mut tables = Vec::with_capacity(relations.len());
        for relation in relations {
            tables.push(self.describe_relation(id, &relation).await?);
        }
        Ok(tables)
    }

    async fn query(
        &self,
        id: &ConnectionId,
        request: &QueryRequest,
        sink: &mut dyn ChunkSink,
    ) -> Result<QueryResult, CoreError> {
        let started = Instant::now();
        if request.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            emit_terminal(sink, request, &[], true).await?;
            return Ok(finished(request, Vec::new(), 0, 0, started, true, false));
        }
        let session = self.session(id)?;
        let mut editor = session.editor.lock().await;
        if editor.is_none() {
            *editor = Some(session.pool.acquire().await.map_err(db_err)?);
        }
        let Some(connection) = editor.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let outcome = run_query(connection, request, sink, started).await;
        if outcome.is_err() && connection.ping().await.is_err() {
            *editor = None;
        }
        outcome
    }

    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError> {
        let pool = self.pool(id)?;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;
        let mut keys = Vec::new();
        for table in tables {
            let rows = sqlx::query(
                "SELECT id, \"table\" AS ref_table, \"from\" AS column_name, \"to\" AS ref_column,
                        on_update, on_delete
                 FROM pragma_foreign_key_list(?1)
                 ORDER BY id, seq",
            )
            .bind(&table)
            .fetch_all(&pool)
            .await
            .map_err(db_err)?;
            for row in &rows {
                let key_id: i64 = row.try_get("id").map_err(db_err)?;
                let column: String = row.try_get("column_name").map_err(db_err)?;
                let ref_column: Option<String> = row.try_get("ref_column").map_err(db_err)?;
                let name = format!("{table}_fk_{key_id}");
                let open = keys
                    .last()
                    .is_some_and(|key: &ForeignKey| key.table == table && key.name == name);
                if !open {
                    keys.push(ForeignKey {
                        name,
                        schema: None,
                        table: table.clone(),
                        columns: Vec::new(),
                        ref_schema: None,
                        ref_table: row.try_get("ref_table").map_err(db_err)?,
                        ref_columns: Vec::new(),
                        on_update: row.try_get("on_update").map_err(db_err)?,
                        on_delete: row.try_get("on_delete").map_err(db_err)?,
                    });
                }
                if let Some(key) = keys.last_mut() {
                    key.columns.push(column);
                    key.ref_columns.extend(ref_column);
                }
            }
        }
        Ok(keys)
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.pool(id)?;
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = connection.prepare(sql).await else {
            return Ok(SqlCheck::clean());
        };
        let Some(db) = err.as_database_error() else {
            return Err(db_err(err));
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position: None,
            code: db.code().map(|code| code.into_owned()),
        }))
    }

    async fn execute_batch_observed(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
        progress: &(dyn Fn(usize) + Send + Sync),
    ) -> Result<BatchResult, CoreError> {
        let started = Instant::now();
        let pool = self.pool(id)?;
        let mut transaction = pool.begin().await.map_err(db_err)?;
        let mut rows_affected = 0;
        for (index, statement) in batch.statements.iter().enumerate() {
            let done = sqlite_query(&statement.sql, &statement.params)?
                .execute(&mut *transaction)
                .await
                .map_err(|err| batch_err(index, &err))?;
            rows_affected += done.rows_affected();
            progress(index + 1);
        }
        transaction.commit().await.map_err(db_err)?;
        Ok(BatchResult {
            statements: batch.statements.len() as u64,
            rows_affected,
            duration_ms: elapsed_ms(started),
        })
    }
}

async fn close_session(session: &Session) {
    if let Ok(mut editor) = session.editor.try_lock() {
        editor.take();
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), session.pool.close()).await;
}

async fn run_query(
    connection: &mut PoolConnection<Sqlite>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let columns = statement_columns(connection, &request.sql).await?;
    if columns.is_empty() {
        let affected = sqlite_query(&request.sql, &request.params)?
            .execute(&mut **connection)
            .await
            .map_err(db_err)?
            .rows_affected();
        emit_terminal(sink, request, &[], true).await?;
        return Ok(finished(request, columns, 0, affected, started, false, false));
    }

    let mut stream = sqlite_query(&request.sql, &request.params)?.fetch(&mut **connection);
    let outcome = emit_chunks(
        &mut stream,
        StreamConfig {
            query_id: &request.query_id,
            columns: &columns,
            chunk_rows: request.chunk_rows,
            max_rows: request.max_rows,
            cancel: &request.cancel,
        },
        decode_sqlite_row,
        sink,
    )
    .await?;
    Ok(finished(
        request,
        columns,
        outcome.row_count,
        0,
        started,
        outcome.cancelled,
        outcome.truncated,
    ))
}

fn connect_options(
    config: &ConnectionConfig,
    path: &Path,
) -> Result<SqliteConnectOptions, CoreError> {
    let mut options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(config.create_if_missing)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    if config.read_only {
        options = options.read_only(true);
    }
    Ok(options)
}

fn resolve_sqlite_path(config: &ConnectionConfig) -> Result<PathBuf, CoreError> {
    if config.read_only && config.create_if_missing {
        return Err(CoreError::InvalidConfig(tr!(
            "a read-only connection can't create the database file",
            "una conexión de solo lectura no puede crear el archivo de la base de datos"
        )));
    }
    let raw = PathBuf::from(&config.database);
    if raw.as_os_str().is_empty() {
        return Err(CoreError::InvalidConfig(tr!(
            "the SQLite file path is empty",
            "la ruta del archivo SQLite está vacía"
        )));
    }
    if raw.exists() {
        return dunce::canonicalize(&raw).map_err(CoreError::from);
    }
    if !config.create_if_missing {
        let path = raw.display();
        return Err(CoreError::InvalidConfig(tr!(
            "the database file wasn't found: {path}",
            "el archivo de la base de datos no existe: {path}"
        )));
    }
    let parent = match raw.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    if !parent.exists() {
        let folder = parent.display();
        return Err(CoreError::InvalidConfig(tr!(
            "the folder wasn't found: {folder}",
            "la carpeta no existe: {folder}"
        )));
    }
    let parent = dunce::canonicalize(parent)?;
    let file_name = raw.file_name().ok_or_else(|| {
        CoreError::InvalidConfig(tr!(
            "the SQLite path has no file name",
            "a la ruta SQLite le falta el nombre del archivo"
        ))
    })?;
    Ok(parent.join(file_name))
}

async fn table_info(pool: &SqlitePool, table: &str) -> Result<Vec<ColumnDefinition>, CoreError> {
    let quoted = quote_ident(table)?;
    let sql = format!("PRAGMA table_info({quoted})");
    let rows = sqlx::query(&sql).fetch_all(pool).await.map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let name: String = row.try_get("name").map_err(db_err)?;
            let data_type: String = row.try_get("type").map_err(db_err)?;
            let not_null: i64 = row.try_get("notnull").map_err(db_err)?;
            let default_value: Option<String> = row.try_get("dflt_value").map_err(db_err)?;
            let primary_key: i64 = row.try_get("pk").map_err(db_err)?;
            Ok(ColumnDefinition {
                name,
                data_type,
                nullable: not_null == 0,
                primary_key: primary_key > 0,
                default_value,
                options: Vec::new(),
                mode: None,
            })
        })
        .collect()
}

async fn statement_columns(
    connection: &mut PoolConnection<Sqlite>,
    sql: &str,
) -> Result<Vec<ColumnDefinition>, CoreError> {
    let statement = connection.prepare(sql).await.map_err(db_err)?;
    Ok(column_defs(statement.columns()))
}

fn sqlite_query<'q>(
    sql: &'q str,
    params: &'q [SqlValue],
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, CoreError> {
    let mut args = sqlx::sqlite::SqliteArguments::default();
    for param in params {
        let added = match param {
            SqlValue::Null => args.add(Option::<i64>::None),
            SqlValue::Bool(value) => args.add(*value),
            SqlValue::Int(value) => args.add(*value),
            SqlValue::Float(value) => args.add(*value),
            SqlValue::Text(value) => args.add(value.as_str()),
            SqlValue::Bytes(value) => args.add(value.as_slice()),
        };
        added.map_err(|err| CoreError::Database(err.to_string()))?;
    }
    Ok(sqlx::query_with(sql, args).persistent(false))
}

fn decode_sqlite_row(row: &SqliteRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_sqlite_cell(row, index)).collect()
}

fn decode_sqlite_cell(row: &SqliteRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    match raw.type_info().name() {
        "BOOLEAN" | "BOOL" => row
            .try_get::<bool, _>(index)
            .map_or_else(|_| fallback_sqlite(row, index), SqlValue::Bool),
        "INTEGER" | "INT" | "INT8" | "BIGINT" => {
            row.try_get::<i64, _>(index).map_or_else(|_| fallback_sqlite(row, index), SqlValue::Int)
        }
        "REAL" | "FLOAT" | "DOUBLE" => {
            row.try_get::<f64, _>(index).map_or_else(|_| fallback_sqlite(row, index), finite_f64)
        }
        "BLOB" | "BINARY" => {
            row.try_get::<Vec<u8>, _>(index).map_or_else(|_| fallback_sqlite(row, index), cap_bytes)
        }
        _ => row.try_get::<String, _>(index).map_or_else(|_| fallback_sqlite(row, index), cap_text),
    }
}

fn fallback_sqlite(row: &SqliteRow, index: usize) -> SqlValue {
    if let Ok(value) = row.try_get::<i64, _>(index) {
        return SqlValue::Int(value);
    }
    if let Ok(value) = row.try_get::<f64, _>(index) {
        return finite_f64(value);
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return cap_text(value);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return cap_bytes(value);
    }
    SqlValue::Text("<unsupported>".into())
}

fn finished(
    request: &QueryRequest,
    columns: Vec<ColumnDefinition>,
    row_count: u64,
    rows_affected: u64,
    started: Instant,
    cancelled: bool,
    truncated: bool,
) -> QueryResult {
    QueryResult {
        query_id: request.query_id.clone(),
        columns,
        row_count,
        rows_affected,
        duration_ms: elapsed_ms(started),
        cancelled,
        truncated,
    }
}

async fn emit_terminal(
    sink: &mut dyn ChunkSink,
    request: &QueryRequest,
    columns: &[ColumnDefinition],
    last: bool,
) -> Result<(), CoreError> {
    sink.on_chunk(RowChunk {
        query_id: request.query_id.clone(),
        index: 0,
        columns: columns.to_vec(),
        rows: Vec::new(),
        last,
    })
    .await
}

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::future::{select, Either};
use futures_util::{StreamExt, TryStreamExt};
use sqlx::mysql::{
    MySqlConnectOptions, MySqlDatabaseError, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode,
};
use sqlx::pool::PoolConnection;
use sqlx::{Arguments, Connection, Executor, MySql, Row, TypeInfo, ValueRef};

use super::decode::{cap_bytes, cap_text, column_defs, finite_f64};
use super::stream::{emit_chunks, StreamConfig};
use super::{batch_err, db_err, elapsed_ms};
use crate::driver::{ChunkSink, DatabaseDriver};
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::ForeignKey;
use crate::types::{
    BatchRequest, BatchResult, ColumnDefinition, ConnectionConfig, ConnectionId, DatabaseEngine,
    QueryRequest, QueryResult, RelationKind, RelationRef, RowChunk, SqlCheck, SqlProblem,
    TableSchema, TlsMode,
};
use crate::value::SqlValue;

/// `ER_UNSUPPORTED_PS`: the statement cannot run through the prepared protocol.
const ER_UNSUPPORTED_PS: u16 = 1295;

/// Marker the frontend reads as "the server fills this column".
const AUTO_INCREMENT: &str = "auto_increment";

/// Routine parameter: mode (procedures only), name, and declared type.
type Parameter = (Option<String>, String, String);

/// Connection the editor keeps, with the thread id used to cancel it.
struct EditorConnection {
    connection: PoolConnection<MySql>,
    thread_id: u64,
}

/// One open database: a pool for catalog reads and batches, plus the
/// connection the editor keeps so transactions span several queries.
struct Session {
    pool: MySqlPool,
    editor: tokio::sync::Mutex<Option<EditorConnection>>,
    /// `DATABASE()` of the session. The catalog shows only this schema.
    database: String,
    mariadb: bool,
}

/// MySQL and MariaDB adapter. Sessions are independent pools keyed by connection id.
pub struct MysqlDriver {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl MysqlDriver {
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
}

impl Default for MysqlDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for MysqlDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Mysql
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let pool = open_pool(config, password, endpoint.as_ref(), 8).await?;
        let (database, version) = server_identity(&pool).await?;
        let id = config.connection_id()?;
        let session = Arc::new(Session {
            pool,
            editor: tokio::sync::Mutex::new(None),
            database,
            mariadb: is_mariadb(&version),
        });
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
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<String, CoreError> {
        let pool = open_pool(config, password, endpoint.as_ref(), 1).await?;
        let identity = server_identity(&pool).await;
        pool.close().await;
        let (_, version) = identity?;
        Ok(if is_mariadb(&version) {
            format!("MariaDB {version}")
        } else {
            format!("MySQL {version}")
        })
    }

    async fn disconnect(&self, id: &ConnectionId) -> Result<(), CoreError> {
        let removed = {
            let mut sessions = self.sessions.write().map_err(|_| CoreError::LockPoisoned)?;
            sessions.remove(id.as_str())
        };
        let Some(session) = removed else {
            return Err(CoreError::NotConnected(id.as_str().to_owned()));
        };
        close_session(&session).await;
        Ok(())
    }

    async fn list_relations(&self, id: &ConnectionId) -> Result<Vec<RelationRef>, CoreError> {
        let session = self.session(id)?;
        let rows = sqlx::query(
            "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
             FROM information_schema.tables
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_NAME",
        )
        .bind(&session.database)
        .fetch_all(&session.pool)
        .await
        .map_err(db_err)?;
        rows.iter()
            .map(|row| {
                Ok(RelationRef {
                    schema: Some(session.database.clone()),
                    name: text(row, "table_name")?,
                    kind: relation_kind(&text(row, "table_type")?),
                })
            })
            .collect()
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        let session = self.session(id)?;
        let schema = relation.schema.clone().unwrap_or_else(|| session.database.clone());
        let keys = primary_keys(&session.pool, &schema, Some(&relation.name)).await?;
        let rows = sqlx::query(
            "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                    COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable,
                    COLUMN_DEFAULT AS column_default, EXTRA AS extra
             FROM information_schema.columns
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
        )
        .bind(&schema)
        .bind(&relation.name)
        .fetch_all(&session.pool)
        .await
        .map_err(db_err)?;
        let columns = rows
            .iter()
            .map(|row| column_from_row(row, &keys, session.mariadb))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TableSchema {
            schema: Some(schema),
            name: relation.name.clone(),
            kind: relation.kind,
            columns,
            definition: None,
            returns: None,
        })
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        let session = self.session(id)?;
        let pool = &session.pool;
        let schema = session.database.as_str();
        let keys = primary_keys(pool, schema, None).await?;
        let views = view_definitions(pool, schema).await?;
        let rows = sqlx::query(
            "SELECT c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
                    c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
                    c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default,
                    c.EXTRA AS extra
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
              AND t.TABLE_NAME = c.TABLE_NAME
             WHERE c.TABLE_SCHEMA = ?
             ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
        )
        .bind(schema)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;

        let mut tables: Vec<TableSchema> = Vec::new();
        for row in &rows {
            let name = text(row, "table_name")?;
            let column = column_from_row(row, &keys, session.mariadb)?;
            match tables.last_mut() {
                Some(table) if table.name == name => table.columns.push(column),
                _ => {
                    let definition = views
                        .get(&name)
                        .map(|body| format!("CREATE VIEW {} AS {body}", quote_mysql(&name)));
                    tables.push(TableSchema {
                        schema: Some(schema.to_owned()),
                        kind: relation_kind(&text(row, "table_type")?),
                        name,
                        columns: vec![column],
                        definition,
                        returns: None,
                    });
                }
            }
        }
        tables.extend(routines(pool, schema).await?);
        tables.extend(triggers(pool, schema).await?);
        tables.extend(indexes(pool, schema, session.mariadb).await?);
        Ok(tables)
    }

    async fn query(
        &self,
        id: &ConnectionId,
        request: &QueryRequest,
        sink: &mut dyn ChunkSink,
    ) -> Result<QueryResult, CoreError> {
        let started = Instant::now();
        if request.cancel.load(Ordering::Relaxed) {
            emit_terminal(sink, request).await?;
            return Ok(finished(request, Vec::new(), 0, 0, started, true, false));
        }
        let session = self.session(id)?;
        let mut editor = session.editor.lock().await;
        if editor.is_none() {
            let mut connection = session.pool.acquire().await.map_err(db_err)?;
            let thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut *connection)
                .await
                .map_err(db_err)?;
            *editor = Some(EditorConnection { connection, thread_id });
        }
        let Some(current) = editor.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let thread_id = current.thread_id;
        let mut sent_cancel = false;
        let outcome = {
            let work = run_query(&mut current.connection, request, sink, started);
            let watch = watch_cancel(&session.pool, thread_id, &request.cancel);
            futures_util::pin_mut!(work, watch);
            match select(work, watch).await {
                Either::Left((outcome, _)) => outcome,
                Either::Right(((), work)) => {
                    sent_cancel = true;
                    work.await
                }
            }
        };
        let cancelled = request.cancel.load(Ordering::Relaxed);
        if cancelled {
            // A stream dropped mid-result leaves rows on the wire. Stop the
            // statement, then resync so the next query does not drain them.
            if !sent_cancel {
                kill_query(&session.pool, thread_id).await;
            }
            if !resync(&mut current.connection).await {
                *editor = None;
            }
        } else if outcome.is_err() && current.connection.ping().await.is_err() {
            *editor = None;
        }
        drop(editor);
        match outcome {
            Err(_) if cancelled => {
                emit_terminal(sink, request).await?;
                Ok(finished(request, Vec::new(), 0, 0, started, true, false))
            }
            other => other,
        }
    }

    async fn foreign_keys(&self, id: &ConnectionId) -> Result<Vec<ForeignKey>, CoreError> {
        let session = self.session(id)?;
        let rows = sqlx::query(
            "SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name,
                    k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS ref_schema,
                    k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column,
                    r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              AND r.TABLE_NAME = k.TABLE_NAME
             WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
        )
        .bind(&session.database)
        .fetch_all(&session.pool)
        .await
        .map_err(db_err)?;
        let mut keys: Vec<ForeignKey> = Vec::new();
        for row in &rows {
            let name = text(row, "name")?;
            let table = text(row, "table_name")?;
            let column = text(row, "column_name")?;
            let ref_column = text(row, "ref_column")?;
            match keys.last_mut() {
                Some(key) if key.name == name && key.table == table => {
                    key.columns.push(column);
                    key.ref_columns.push(ref_column);
                }
                _ => keys.push(ForeignKey {
                    name,
                    schema: Some(session.database.clone()),
                    table,
                    columns: vec![column],
                    ref_schema: Some(text(row, "ref_schema")?),
                    ref_table: text(row, "ref_table")?,
                    ref_columns: vec![ref_column],
                    on_update: text(row, "on_update")?,
                    on_delete: text(row, "on_delete")?,
                }),
            }
        }
        Ok(keys)
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.session(id)?.pool.clone();
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = (&mut *connection).describe(sql).await else {
            return Ok(SqlCheck::clean());
        };
        if is_unsupported_ps(&err) {
            return Ok(SqlCheck::unknown());
        }
        let Some(db) =
            err.as_database_error().and_then(|db| db.try_downcast_ref::<MySqlDatabaseError>())
        else {
            return Err(db_err(err));
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position: None,
            code: Some(db.number().to_string()),
        }))
    }

    async fn execute_batch_observed(
        &self,
        id: &ConnectionId,
        batch: &BatchRequest,
        progress: &(dyn Fn(usize) + Send + Sync),
    ) -> Result<BatchResult, CoreError> {
        let started = Instant::now();
        let pool = self.session(id)?.pool.clone();
        let mut transaction = pool.begin().await.map_err(db_err)?;
        let mut rows_affected = 0;
        for (index, statement) in batch.statements.iter().enumerate() {
            let done = my_query(&statement.sql, &statement.params)?
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

async fn open_pool(
    config: &ConnectionConfig,
    password: Option<&SecretString>,
    endpoint: Option<&(String, u16)>,
    max_connections: u32,
) -> Result<MySqlPool, CoreError> {
    let options = my_options(config, password, endpoint)?;
    let mut pool = MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(15));
    if config.read_only {
        // Enforced by the server on every connection, so SQL typed in the
        // editor cannot write either.
        pool = pool.after_connect(|connection, _meta| {
            Box::pin(async move {
                connection.execute("SET SESSION TRANSACTION READ ONLY").await?;
                Ok(())
            })
        });
    }
    pool.connect_with(options).await.map_err(db_err)
}

async fn server_identity(pool: &MySqlPool) -> Result<(String, String), CoreError> {
    let row = sqlx::query("SELECT DATABASE() AS db, VERSION() AS version")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    let database = opt_text(&row, "db")?.ok_or_else(|| {
        CoreError::InvalidConfig(tr!(
            "the MySQL session has no database selected",
            "la sesión MySQL no tiene una base de datos elegida"
        ))
    })?;
    Ok((database, text(&row, "version")?))
}

fn is_mariadb(version: &str) -> bool {
    version.to_ascii_lowercase().contains("mariadb")
}

async fn close_session(session: &Session) {
    if let Ok(mut editor) = session.editor.try_lock() {
        editor.take();
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), session.pool.close()).await;
}

/// Resolves after asking the server to stop `thread_id`'s statement, once `cancel` is set.
async fn watch_cancel(pool: &MySqlPool, thread_id: u64, cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    kill_query(pool, thread_id).await;
}

async fn kill_query(pool: &MySqlPool, thread_id: u64) {
    // `thread_id` is a number from CONNECTION_ID(), so formatting it is safe.
    let sql = format!("KILL QUERY {thread_id}");
    let _ = pool.execute(sql.as_str()).await;
}

/// Drains what a cancelled statement left behind. A `KILL QUERY` that lands
/// after the statement finished can interrupt the next one, so a single
/// interrupted probe is tolerated before the connection is given up.
async fn resync(connection: &mut PoolConnection<MySql>) -> bool {
    for _ in 0..2 {
        if connection.execute("DO 0").await.is_ok() {
            return true;
        }
        if connection.ping().await.is_err() {
            return false;
        }
    }
    false
}

async fn run_query(
    connection: &mut PoolConnection<MySql>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let described = statement_columns(connection, &request.sql).await?;
    // Reads go through the text protocol, like the mysql client: values arrive as
    // MySQL prints them (DATETIME(3) keeps .500), and statements the prepared
    // protocol rejects still run. Parameters are written in as literals.
    let sql = if request.params.is_empty() {
        request.sql.clone()
    } else {
        inline_params(&request.sql, &request.params)?
    };
    let mut stream = (&mut **connection).fetch_many(sql.as_str());

    let mut rows_affected = 0;
    let first = loop {
        if request.cancel.load(Ordering::Relaxed) {
            break None;
        }
        match stream.try_next().await.map_err(db_err)? {
            Some(sqlx::Either::Left(done)) => rows_affected += done.rows_affected(),
            Some(sqlx::Either::Right(row)) => break Some(row),
            None => break None,
        }
    };
    let columns = match (&first, described) {
        (_, Some(columns)) if !columns.is_empty() => columns,
        (Some(row), _) => column_defs(row.columns()),
        (None, _) => Vec::new(),
    };
    if columns.is_empty() {
        let cancelled = request.cancel.load(Ordering::Relaxed);
        emit_terminal(sink, request).await?;
        return Ok(finished(request, columns, 0, rows_affected, started, cancelled, false));
    }

    let rows = futures_util::stream::iter(first.map(Ok))
        .chain(stream.try_filter_map(|item| futures_util::future::ready(Ok(item.right()))));
    let outcome = emit_chunks(
        rows,
        StreamConfig {
            query_id: &request.query_id,
            columns: &columns,
            chunk_rows: request.chunk_rows,
            max_rows: request.max_rows,
            cancel: &request.cancel,
        },
        decode_my_row,
        sink,
    )
    .await?;
    Ok(finished(
        request,
        columns,
        outcome.row_count,
        rows_affected,
        started,
        outcome.cancelled,
        outcome.truncated,
    ))
}

/// Result columns from the prepared protocol, or `None` when the server
/// cannot prepare the statement and columns must come from the first row.
async fn statement_columns(
    connection: &mut PoolConnection<MySql>,
    sql: &str,
) -> Result<Option<Vec<ColumnDefinition>>, CoreError> {
    match (&mut **connection).describe(sql).await {
        Ok(describe) => Ok(Some(column_defs(describe.columns()))),
        Err(err) if is_unsupported_ps(&err) => Ok(None),
        Err(err) => Err(db_err(err)),
    }
}

fn is_unsupported_ps(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|db| db.try_downcast_ref::<MySqlDatabaseError>())
        .is_some_and(|db| db.number() == ER_UNSUPPORTED_PS)
}

fn my_options(
    config: &ConnectionConfig,
    password: Option<&SecretString>,
    endpoint: Option<&(String, u16)>,
) -> Result<MySqlConnectOptions, CoreError> {
    config.validate()?;
    if config.engine != DatabaseEngine::Mysql {
        return Err(CoreError::InvalidConfig(
            "mysql driver received a non-mysql connection".into(),
        ));
    }
    let username = config.username.as_deref().ok_or_else(|| {
        CoreError::InvalidConfig(tr!("MySQL needs a username", "MySQL necesita un usuario"))
    })?;
    let (host, port) = match endpoint {
        Some((host, port)) => (host.as_str(), *port),
        None => (config.host.as_deref().unwrap_or("localhost"), config.port.unwrap_or(3306)),
    };
    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .database(&config.database)
        .charset("utf8mb4")
        .ssl_mode(my_ssl_mode(config.tls.mode))
        // Keep the server's sql_mode and time zone: a client must not change
        // what `||` means or how TIMESTAMP values read.
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None);
    if let Some(secret) = password {
        options = options.password(secret.expose());
    }
    if let Some(path) = &config.tls.root_cert {
        options = options.ssl_ca(path);
    }
    if let Some(path) = &config.tls.client_cert {
        options = options.ssl_client_cert(path);
    }
    if let Some(path) = &config.tls.client_key {
        options = options.ssl_client_key(path);
    }
    Ok(options)
}

fn my_ssl_mode(mode: TlsMode) -> MySqlSslMode {
    match mode {
        TlsMode::Disable => MySqlSslMode::Disabled,
        TlsMode::Prefer => MySqlSslMode::Preferred,
        TlsMode::Require => MySqlSslMode::Required,
        TlsMode::VerifyCa => MySqlSslMode::VerifyCa,
        TlsMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

fn relation_kind(table_type: &str) -> RelationKind {
    match table_type {
        "VIEW" | "SYSTEM VIEW" => RelationKind::View,
        "SEQUENCE" => RelationKind::Sequence,
        _ => RelationKind::Table,
    }
}

/// Reads a catalog string. information_schema columns can arrive flagged as
/// binary on MySQL 8, so the type check is skipped.
fn text(row: &MySqlRow, name: &str) -> Result<String, CoreError> {
    opt_text(row, name)?.ok_or_else(|| CoreError::Database(format!("{name} is NULL")))
}

fn opt_text(row: &MySqlRow, name: &str) -> Result<Option<String>, CoreError> {
    let raw = row.try_get_raw(name).map_err(db_err)?;
    if raw.is_null() {
        return Ok(None);
    }
    row.try_get_unchecked::<String, _>(name).map(Some).map_err(db_err)
}

fn opt_int(row: &MySqlRow, name: &str) -> Result<Option<i64>, CoreError> {
    let raw = row.try_get_raw(name).map_err(db_err)?;
    if raw.is_null() {
        return Ok(None);
    }
    row.try_get_unchecked::<i64, _>(name).map(Some).map_err(db_err)
}

fn quote_mysql(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

async fn primary_keys(
    pool: &MySqlPool,
    schema: &str,
    table: Option<&str>,
) -> Result<HashSet<(String, String)>, CoreError> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM information_schema.key_column_usage
         WHERE CONSTRAINT_NAME = 'PRIMARY'
           AND TABLE_SCHEMA = ?
           AND (? IS NULL OR TABLE_NAME = ?)",
    )
    .bind(schema)
    .bind(table)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter().map(|row| Ok((text(row, "table_name")?, text(row, "column_name")?))).collect()
}

fn column_from_row(
    row: &MySqlRow,
    keys: &HashSet<(String, String)>,
    mariadb: bool,
) -> Result<ColumnDefinition, CoreError> {
    let table = text(row, "table_name")?;
    let name = text(row, "column_name")?;
    let data_type = text(row, "column_type")?;
    let nullable = text(row, "is_nullable")?;
    let extra = opt_text(row, "extra")?.unwrap_or_default();
    let mut default_value = opt_text(row, "column_default")?;
    // MariaDB reports "no default" on a nullable column as the literal NULL;
    // a string default would arrive quoted.
    if mariadb && default_value.as_deref() == Some("NULL") {
        default_value = None;
    }
    if default_value.is_none() && extra.to_ascii_lowercase().contains(AUTO_INCREMENT) {
        default_value = Some(AUTO_INCREMENT.to_owned());
    }
    Ok(ColumnDefinition {
        primary_key: keys.contains(&(table, name.clone())),
        name,
        options: enum_labels(&data_type),
        mode: None,
        data_type,
        nullable: nullable.eq_ignore_ascii_case("YES"),
        default_value,
    })
}

/// Labels of an `enum('a','b')` or `set('a','b')` column type.
fn enum_labels(column_type: &str) -> Vec<String> {
    let lower = column_type.to_ascii_lowercase();
    let body = if lower.starts_with("enum(") {
        &column_type[5..]
    } else if lower.starts_with("set(") {
        &column_type[4..]
    } else {
        return Vec::new();
    };
    let mut labels = Vec::new();
    let mut chars = body.chars().peekable();
    loop {
        while chars.next_if(|c| *c == ',' || c.is_whitespace()).is_some() {}
        if chars.next() != Some('\'') {
            break;
        }
        let mut label = String::new();
        loop {
            match chars.next() {
                None => return labels,
                Some('\'') if chars.peek() == Some(&'\'') => {
                    chars.next();
                    label.push('\'');
                }
                Some('\'') => break,
                // The catalog escapes a backslash in a label as `\\`.
                Some('\\') => match chars.next() {
                    Some(escaped @ ('\\' | '\'')) => label.push(escaped),
                    Some(other) => {
                        label.push('\\');
                        label.push(other);
                    }
                    None => return labels,
                },
                Some(other) => label.push(other),
            }
        }
        labels.push(label);
    }
    labels
}

async fn view_definitions(
    pool: &MySqlPool,
    schema: &str,
) -> Result<HashMap<String, String>, CoreError> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME AS name, VIEW_DEFINITION AS body
         FROM information_schema.views
         WHERE TABLE_SCHEMA = ?",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut views = HashMap::new();
    for row in &rows {
        if let Some(body) = opt_text(row, "body")?.filter(|body| !body.is_empty()) {
            views.insert(text(row, "name")?, body);
        }
    }
    Ok(views)
}

async fn routines(pool: &MySqlPool, schema: &str) -> Result<Vec<TableSchema>, CoreError> {
    let params = sqlx::query(
        "SELECT SPECIFIC_NAME AS specific_name, ROUTINE_TYPE AS routine_type,
                PARAMETER_MODE AS parameter_mode, PARAMETER_NAME AS parameter_name,
                DTD_IDENTIFIER AS data_type
         FROM information_schema.parameters
         WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
         ORDER BY SPECIFIC_NAME, ORDINAL_POSITION",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut arguments: HashMap<(String, String), Vec<Parameter>> = HashMap::new();
    for row in &params {
        let key = (text(row, "routine_type")?, text(row, "specific_name")?);
        let name = opt_text(row, "parameter_name")?.unwrap_or_default();
        let data_type = opt_text(row, "data_type")?.unwrap_or_default();
        let mode = opt_text(row, "parameter_mode")?;
        arguments.entry(key).or_default().push((mode, name, data_type));
    }

    let rows = sqlx::query(
        "SELECT SPECIFIC_NAME AS specific_name, ROUTINE_NAME AS routine_name,
                ROUTINE_TYPE AS routine_type, DTD_IDENTIFIER AS returns,
                ROUTINE_DEFINITION AS body
         FROM information_schema.routines
         WHERE ROUTINE_SCHEMA = ?
         ORDER BY ROUTINE_NAME",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let kind = text(row, "routine_type")?;
            let name = text(row, "routine_name")?;
            let specific = text(row, "specific_name")?;
            let procedure = kind.eq_ignore_ascii_case("PROCEDURE");
            let args = arguments.get(&(kind, specific)).map(Vec::as_slice).unwrap_or_default();
            let signature = args
                .iter()
                .map(|(mode, arg, data_type)| match mode {
                    Some(mode) if procedure => {
                        format!("{mode} {} {data_type}", quote_mysql(arg))
                    }
                    _ => format!("{} {data_type}", quote_mysql(arg)),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let returns = opt_text(row, "returns")?.filter(|_| !procedure);
            let definition = opt_text(row, "body")?.map(|body| {
                let header = if procedure { "PROCEDURE" } else { "FUNCTION" };
                let returns =
                    returns.as_deref().map(|ty| format!(" RETURNS {ty}")).unwrap_or_default();
                format!("CREATE {header} {}({signature}){returns}\n{body}", quote_mysql(&name))
            });
            Ok(TableSchema {
                schema: Some(schema.to_owned()),
                name,
                kind: if procedure { RelationKind::Procedure } else { RelationKind::Function },
                columns: args
                    .iter()
                    .map(|(mode, arg, data_type)| ColumnDefinition {
                        // Function parameters have no mode in the catalog; they are all inputs.
                        mode: Some(mode.clone().unwrap_or_else(|| "IN".to_owned())),
                        ..plain_column(arg, data_type)
                    })
                    .collect(),
                definition,
                returns,
            })
        })
        .collect()
}

async fn triggers(pool: &MySqlPool, schema: &str) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT TRIGGER_NAME AS trigger_name, ACTION_TIMING AS timing,
                EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS table_name,
                ACTION_STATEMENT AS body
         FROM information_schema.triggers
         WHERE TRIGGER_SCHEMA = ?
         ORDER BY TRIGGER_NAME",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let name = text(row, "trigger_name")?;
            let definition = format!(
                "CREATE TRIGGER {} {} {} ON {} FOR EACH ROW {}",
                quote_mysql(&name),
                text(row, "timing")?,
                text(row, "event")?,
                quote_mysql(&text(row, "table_name")?),
                opt_text(row, "body")?.unwrap_or_default(),
            );
            Ok(TableSchema {
                schema: Some(schema.to_owned()),
                name,
                kind: RelationKind::Trigger,
                columns: Vec::new(),
                definition: Some(definition),
                returns: None,
            })
        })
        .collect()
}

/// Indexes are named `table.index`: MySQL scopes index names to a table, so
/// every table has its own `PRIMARY`.
async fn indexes(
    pool: &MySqlPool,
    schema: &str,
    mariadb: bool,
) -> Result<Vec<TableSchema>, CoreError> {
    // Functional key parts (MySQL 8.0.13+) have no column, only an expression.
    let expression = if mariadb { "NULL" } else { "EXPRESSION" };
    let sql = format!(
        "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
                NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name,
                {expression} AS expression, SUB_PART AS sub_part,
                COLLATION AS collation, INDEX_TYPE AS index_type
         FROM information_schema.statistics
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
    );
    let rows = sqlx::query(&sql).bind(schema).fetch_all(pool).await.map_err(db_err)?;

    struct Index {
        table: String,
        name: String,
        unique: bool,
        index_type: String,
        parts: Vec<String>,
    }
    let mut found: Vec<Index> = Vec::new();
    for row in &rows {
        let table = text(row, "table_name")?;
        let name = text(row, "index_name")?;
        let mut part = match opt_text(row, "column_name")? {
            Some(column) => quote_mysql(&column),
            None => format!("({})", opt_text(row, "expression")?.unwrap_or_default()),
        };
        if let Some(length) = opt_int(row, "sub_part")? {
            part.push_str(&format!("({length})"));
        }
        if opt_text(row, "collation")?.as_deref() == Some("D") {
            part.push_str(" DESC");
        }
        match found.last_mut() {
            Some(index) if index.table == table && index.name == name => index.parts.push(part),
            _ => found.push(Index {
                unique: opt_int(row, "non_unique")? == Some(0),
                index_type: opt_text(row, "index_type")?.unwrap_or_default(),
                table,
                name,
                parts: vec![part],
            }),
        }
    }
    Ok(found
        .into_iter()
        .map(|index| {
            let parts = index.parts.join(", ");
            let table = quote_mysql(&index.table);
            let definition = if index.name == "PRIMARY" {
                format!("ALTER TABLE {table} ADD PRIMARY KEY ({parts})")
            } else {
                let prefix = match index.index_type.as_str() {
                    "FULLTEXT" => "FULLTEXT ",
                    "SPATIAL" => "SPATIAL ",
                    _ if index.unique => "UNIQUE ",
                    _ => "",
                };
                let using = if index.index_type == "HASH" { " USING HASH" } else { "" };
                format!(
                    "CREATE {prefix}INDEX {} ON {table} ({parts}){using}",
                    quote_mysql(&index.name)
                )
            };
            TableSchema {
                schema: Some(schema.to_owned()),
                name: format!("{}.{}", index.table, index.name),
                kind: RelationKind::Index,
                columns: Vec::new(),
                definition: Some(definition),
                returns: None,
            }
        })
        .collect())
}

fn plain_column(name: &str, data_type: &str) -> ColumnDefinition {
    ColumnDefinition {
        name: name.to_owned(),
        data_type: data_type.to_owned(),
        nullable: true,
        primary_key: false,
        default_value: None,
        options: Vec::new(),
        mode: None,
    }
}

fn my_query<'q>(
    sql: &'q str,
    params: &'q [SqlValue],
) -> Result<sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>, CoreError> {
    let mut args = sqlx::mysql::MySqlArguments::default();
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

fn decode_my_row(row: &MySqlRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_my_cell(row, index)).collect()
}

/// Decodes one cell of a text-protocol row.
fn decode_my_cell(row: &MySqlRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    let decoded = match type_name.as_str() {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
            row.try_get_unchecked::<i64, _>(index).ok().map(SqlValue::Int)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" | "YEAR" | "BIT" => {
            row.try_get_unchecked::<u64, _>(index).ok().map(|value| match i64::try_from(value) {
                Ok(value) => SqlValue::Int(value),
                Err(_) => SqlValue::Text(value.to_string()),
            })
        }
        "FLOAT" => {
            row.try_get_unchecked::<f32, _>(index).ok().map(|value| finite_f64(f64::from(value)))
        }
        "DOUBLE" => row.try_get_unchecked::<f64, _>(index).ok().map(finite_f64),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            row.try_get_unchecked::<Vec<u8>, _>(index).ok().map(bytes_or_text)
        }
        "GEOMETRY" => row.try_get_unchecked::<Vec<u8>, _>(index).ok().map(cap_bytes),
        _ => None,
    };
    if let Some(value) = decoded {
        return value;
    }
    // DECIMAL, JSON, temporal text, and character types all arrive as text.
    if let Ok(value) = row.try_get_unchecked::<String, _>(index) {
        return cap_text(value);
    }
    if let Ok(value) = row.try_get_unchecked::<Vec<u8>, _>(index) {
        return cap_bytes(value);
    }
    SqlValue::Text(format!("<{type_name}>"))
}

/// The protocol flags `_bin` collations (and MariaDB's JSON) like binary
/// strings, and the charset that tells them apart is not exposed. Readable
/// UTF-8 is shown as text; anything else stays bytes.
fn bytes_or_text(bytes: Vec<u8>) -> SqlValue {
    match String::from_utf8(bytes) {
        Ok(text) if !text.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) => {
            cap_text(text)
        }
        Ok(text) => cap_bytes(text.into_bytes()),
        Err(err) => cap_bytes(err.into_bytes()),
    }
}

/// Writes each `?` as a SQL literal so a query with parameters still reads over
/// the text protocol. Placeholders inside strings, quoted identifiers, and
/// comments are left alone. Text goes in as a hex literal, which reads the same
/// whatever the server's escaping mode.
fn inline_params(sql: &str, params: &[SqlValue]) -> Result<String, CoreError> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut next_param = params.iter();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        match c {
            '\'' | '"' | '`' => {
                let start = at;
                at += 1;
                while at < chars.len() {
                    if chars[at] == '\\' && c != '`' {
                        at += 2;
                        continue;
                    }
                    if chars[at] == c {
                        if chars.get(at + 1) == Some(&c) {
                            at += 2;
                            continue;
                        }
                        break;
                    }
                    at += 1;
                }
                at = (at + 1).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '#' => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '-' if next == Some('-') && chars.get(at + 2).is_none_or(|c| c.is_whitespace()) => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '/' if next == Some('*') => {
                let start = at;
                at += 2;
                while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                    at += 1;
                }
                at = (at + 2).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '?' => {
                let value = next_param.next().ok_or_else(|| {
                    CoreError::Database(tr!(
                        "the statement has more ? placeholders than parameters",
                        "la sentencia tiene más ? que parámetros"
                    ))
                })?;
                out.push_str(&sql_literal(value));
                at += 1;
            }
            _ => {
                out.push(c);
                at += 1;
            }
        }
    }
    Ok(out)
}

fn sql_literal(value: &SqlValue) -> String {
    let hex = |bytes: &[u8]| bytes.iter().map(|byte| format!("{byte:02X}")).collect::<String>();
    match value {
        SqlValue::Null => "NULL".into(),
        SqlValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
        SqlValue::Int(value) if *value < 0 => format!("({value})"),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) if *value < 0.0 => format!("({value:?})"),
        SqlValue::Float(value) => format!("{value:?}"),
        SqlValue::Text(text) if text.is_empty() => "''".into(),
        SqlValue::Text(text) => format!("_utf8mb4 X'{}'", hex(text.as_bytes())),
        SqlValue::Bytes(bytes) if bytes.is_empty() => "X''".into(),
        SqlValue::Bytes(bytes) => format!("X'{}'", hex(bytes)),
    }
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

async fn emit_terminal(sink: &mut dyn ChunkSink, request: &QueryRequest) -> Result<(), CoreError> {
    sink.on_chunk(RowChunk {
        query_id: request.query_id.clone(),
        index: 0,
        columns: Vec::new(),
        rows: Vec::new(),
        last: true,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_labels_handle_quotes_and_sets() {
        assert_eq!(enum_labels("enum('a','it''s','c d')"), vec!["a", "it's", "c d"]);
        assert_eq!(enum_labels("set('x','y')"), vec!["x", "y"]);
        assert_eq!(enum_labels("ENUM('A')"), vec!["A"]);
        assert!(enum_labels("varchar(10)").is_empty());
        assert_eq!(enum_labels("enum('')"), vec![""]);
        assert_eq!(enum_labels(r"enum('a\\b','c')"), vec![r"a\b", "c"]);
    }

    #[test]
    fn inlines_placeholders_outside_strings_and_comments() {
        let params =
            [SqlValue::Int(-5), SqlValue::Text("it's".into()), SqlValue::Bytes(vec![0xde])];
        let sql = "select ?, '?', \"?\", `?`, ? # ?\n/* ? */ -- ?\n, 'a\\'?', ?";
        assert_eq!(
            inline_params(sql, &params).expect("inline"),
            "select (-5), '?', \"?\", `?`, _utf8mb4 X'69742773' # ?\n/* ? */ -- ?\n, 'a\\'?', X'DE'"
        );
        assert!(inline_params("select ?, ?, ?, ?", &params).is_err());
    }
}

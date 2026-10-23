use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::future::{select, Either};
use sqlx::pool::PoolConnection;
use sqlx::postgres::{
    PgConnectOptions, PgDatabaseError, PgErrorPosition, PgPool, PgPoolOptions, PgRow, PgSslMode,
};
use sqlx::postgres::{PgTypeInfo, PgValueFormat};
use sqlx::{Arguments, Connection, Executor, Postgres, Row, Statement, TypeInfo, ValueRef};

use super::decode::{cap_bytes, cap_text, column_defs};
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

type EnumLabels = HashMap<(String, String), Vec<String>>;

/// Connection the editor keeps, with the backend pid used to cancel it.
struct EditorConnection {
    connection: PoolConnection<Postgres>,
    pid: i32,
}

/// One open database: a pool for catalog reads and batches, the editor
/// connection, and enum labels cached since the last introspection.
struct Session {
    pool: PgPool,
    editor: tokio::sync::Mutex<Option<EditorConnection>>,
    enums: RwLock<Arc<EnumLabels>>,
}

impl Session {
    fn enums(&self) -> Result<Arc<EnumLabels>, CoreError> {
        Ok(Arc::clone(&*self.enums.read().map_err(|_| CoreError::LockPoisoned)?))
    }

    fn set_enums(&self, labels: EnumLabels) -> Result<(), CoreError> {
        *self.enums.write().map_err(|_| CoreError::LockPoisoned)? = Arc::new(labels);
        Ok(())
    }
}

/// PostgreSQL adapter. Sessions are independent pools keyed by connection id.
pub struct PostgresDriver {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl PostgresDriver {
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

    fn pool(&self, id: &ConnectionId) -> Result<PgPool, CoreError> {
        Ok(self.session(id)?.pool.clone())
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn engine(&self) -> DatabaseEngine {
        DatabaseEngine::Postgres
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&SecretString>,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let options = pg_options(config, password, endpoint.as_ref())?;
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(options)
            .await
            .map_err(db_err)?;
        let enums = enum_labels(&pool).await?;
        let id = config.connection_id()?;
        let session = Arc::new(Session {
            pool,
            editor: tokio::sync::Mutex::new(None),
            enums: RwLock::new(Arc::new(enums)),
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
        let options = pg_options(config, password, endpoint.as_ref())?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(options)
            .await
            .map_err(db_err)?;
        let version: String =
            sqlx::query_scalar("SELECT version()").fetch_one(&pool).await.map_err(db_err)?;
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
            "SELECT table_schema, table_name, table_type
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name",
        )
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;
        rows.iter().map(relation_from_row).collect()
    }

    async fn describe_relation(
        &self,
        id: &ConnectionId,
        relation: &RelationRef,
    ) -> Result<TableSchema, CoreError> {
        let schema = relation.schema.as_deref().ok_or_else(|| {
            CoreError::InvalidConfig("postgres relations require a schema".into())
        })?;
        let pool = self.pool(id)?;
        let keys = primary_keys(&pool, Some((schema, relation.name.as_str()))).await?;
        let enums = enum_labels(&pool).await?;
        let rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.udt_schema, c.udt_name, c.is_nullable, c.column_default,
                    pg_catalog.format_type(pa.atttypid, pa.atttypmod) AS full_type
             FROM information_schema.columns c
             LEFT JOIN pg_catalog.pg_namespace pn ON pn.nspname = c.table_schema
             LEFT JOIN pg_catalog.pg_class pc ON pc.relnamespace = pn.oid AND pc.relname = c.table_name
             LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position",
        )
        .bind(schema)
        .bind(&relation.name)
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;
        let columns = rows
            .iter()
            .map(|row| column_from_row(row, schema, &relation.name, &keys, &enums))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TableSchema {
            schema: Some(schema.to_owned()),
            name: relation.name.clone(),
            kind: relation.kind,
            columns,
            definition: None,
        })
    }

    async fn introspect(&self, id: &ConnectionId) -> Result<Vec<TableSchema>, CoreError> {
        let session = self.session(id)?;
        let pool = session.pool.clone();
        let keys = primary_keys(&pool, None).await?;
        let enums = enum_labels(&pool).await?;
        session.set_enums(enums.clone())?;
        let rows = sqlx::query(
            "SELECT c.table_schema, c.table_name, t.table_type,
                    c.column_name, c.data_type, c.udt_schema, c.udt_name, c.is_nullable, c.column_default,
                    pg_catalog.format_type(pa.atttypid, pa.atttypmod) AS full_type
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema
              AND t.table_name = c.table_name
             LEFT JOIN pg_catalog.pg_namespace pn ON pn.nspname = c.table_schema
             LEFT JOIN pg_catalog.pg_class pc ON pc.relnamespace = pn.oid AND pc.relname = c.table_name
             LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name
             WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY c.table_schema, c.table_name, c.ordinal_position",
        )
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;

        let mut tables: Vec<TableSchema> = Vec::new();
        for row in &rows {
            let schema: String = row.try_get("table_schema").map_err(db_err)?;
            let name: String = row.try_get("table_name").map_err(db_err)?;
            let column = column_from_row(row, &schema, &name, &keys, &enums)?;
            let same = tables.last().is_some_and(|table| {
                table.schema.as_deref() == Some(schema.as_str()) && table.name == name
            });
            if same {
                if let Some(table) = tables.last_mut() {
                    table.columns.push(column);
                }
            } else {
                let kind: String = row.try_get("table_type").map_err(db_err)?;
                tables.push(TableSchema {
                    schema: Some(schema),
                    name,
                    kind: relation_kind(&kind),
                    columns: vec![column],
                    definition: None,
                });
            }
        }
        tables.extend(catalog_objects(&pool).await?);
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
            emit_terminal(sink, request).await?;
            return Ok(finished(request, Vec::new(), 0, 0, started, true, false));
        }
        let session = self.session(id)?;
        let enums = session.enums()?;
        let mut editor = session.editor.lock().await;
        if editor.is_none() {
            let mut connection = session.pool.acquire().await.map_err(db_err)?;
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *connection)
                .await
                .map_err(db_err)?;
            *editor = Some(EditorConnection { connection, pid });
        }
        let Some(current) = editor.as_mut() else {
            return Err(CoreError::Internal("editor connection is missing".into()));
        };
        let pid = current.pid;
        let mut sent_cancel = false;
        let outcome = {
            let work = run_query(&mut current.connection, request, sink, &enums, started);
            let watch = watch_cancel(&session.pool, pid, &request.cancel);
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
            // backend and resync so the next query does not drain them.
            if !sent_cancel {
                cancel_backend(&session.pool, pid).await;
            }
            if current.connection.ping().await.is_err() {
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
        let pool = self.pool(id)?;
        let rows = sqlx::query(
            "SELECT con.conname::text AS name,
                    ns.nspname::text AS schema_name,
                    cl.relname::text AS table_name,
                    array_agg(att.attname::text ORDER BY k.ord) AS columns,
                    fns.nspname::text AS ref_schema,
                    fcl.relname::text AS ref_table,
                    array_agg(fatt.attname::text ORDER BY k.ord) AS ref_columns,
                    con.confupdtype::text AS on_update,
                    con.confdeltype::text AS on_delete
             FROM pg_constraint con
             JOIN pg_class cl ON cl.oid = con.conrelid
             JOIN pg_namespace ns ON ns.oid = cl.relnamespace
             JOIN pg_class fcl ON fcl.oid = con.confrelid
             JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
             CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
             JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = k.fattnum
             WHERE con.contype = 'f'
               AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
             GROUP BY con.oid, con.conname, ns.nspname, cl.relname, fns.nspname, fcl.relname,
                      con.confupdtype, con.confdeltype
             ORDER BY 2, 3, 1",
        )
        .fetch_all(&pool)
        .await
        .map_err(db_err)?;
        rows.iter()
            .map(|row| {
                Ok(ForeignKey {
                    name: row.try_get("name").map_err(db_err)?,
                    schema: Some(row.try_get("schema_name").map_err(db_err)?),
                    table: row.try_get("table_name").map_err(db_err)?,
                    columns: row.try_get("columns").map_err(db_err)?,
                    ref_schema: Some(row.try_get("ref_schema").map_err(db_err)?),
                    ref_table: row.try_get("ref_table").map_err(db_err)?,
                    ref_columns: row.try_get("ref_columns").map_err(db_err)?,
                    on_update: pg_action(&row.try_get::<String, _>("on_update").map_err(db_err)?),
                    on_delete: pg_action(&row.try_get::<String, _>("on_delete").map_err(db_err)?),
                })
            })
            .collect()
    }

    async fn check(&self, id: &ConnectionId, sql: &str) -> Result<SqlCheck, CoreError> {
        let pool = self.pool(id)?;
        let mut connection = pool.acquire().await.map_err(db_err)?;
        let Err(err) = connection.prepare(sql).await else {
            return Ok(SqlCheck::clean());
        };
        let Some(db) =
            err.as_database_error().and_then(|db| db.try_downcast_ref::<PgDatabaseError>())
        else {
            return Err(db_err(err));
        };
        // Untyped parameters are valid SQL the server just cannot type yet.
        if db.code() == "42P18" {
            return Ok(SqlCheck::unknown());
        }
        let position = match db.position() {
            Some(PgErrorPosition::Original(position)) => u32::try_from(position).ok(),
            _ => None,
        };
        Ok(SqlCheck::failed(SqlProblem {
            message: db.message().to_owned(),
            position,
            code: Some(db.code().to_owned()),
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
            let done = pg_query(&statement.sql, &statement.params)?
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

/// Resolves after asking the server to cancel `pid`, once `cancel` is set.
async fn watch_cancel(pool: &PgPool, pid: i32, cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    cancel_backend(pool, pid).await;
}

async fn cancel_backend(pool: &PgPool, pid: i32) {
    let _ = sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(pool).await;
}

async fn run_query(
    connection: &mut PoolConnection<Postgres>,
    request: &QueryRequest,
    sink: &mut dyn ChunkSink,
    enums: &EnumLabels,
    started: Instant,
) -> Result<QueryResult, CoreError> {
    let columns = statement_columns(connection, &request.sql, &request.params, enums).await?;
    if columns.is_empty() {
        let affected = pg_query(&request.sql, &request.params)?
            .execute(&mut **connection)
            .await
            .map_err(db_err)?
            .rows_affected();
        emit_terminal(sink, request).await?;
        return Ok(finished(request, columns, 0, affected, started, false, false));
    }
    // Reads use the simple protocol: PostgreSQL then sends every value as text, printed by the
    // type's own output function, so any type (extensions included) reads as psql shows it.
    // Some types (aclitem) cannot be sent in binary at all, and chrono panics on ±infinity.
    let sql = if request.params.is_empty() {
        request.sql.clone()
    } else {
        inline_params(&request.sql, &request.params)?
    };
    let mut stream = sqlx::raw_sql(&sql).fetch(&mut **connection);
    let outcome = emit_chunks(
        &mut stream,
        StreamConfig {
            query_id: &request.query_id,
            columns: &columns,
            chunk_rows: request.chunk_rows,
            max_rows: request.max_rows,
            cancel: &request.cancel,
        },
        decode_pg_row,
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

/// Spells out the one-letter action codes of `pg_constraint`.
fn pg_action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_owned()
}

fn pg_options(
    config: &ConnectionConfig,
    password: Option<&SecretString>,
    endpoint: Option<&(String, u16)>,
) -> Result<PgConnectOptions, CoreError> {
    config.validate()?;
    if config.engine != DatabaseEngine::Postgres {
        return Err(CoreError::InvalidConfig(
            "postgres driver received a non-postgres connection".into(),
        ));
    }
    let username = config.username.as_deref().ok_or_else(|| {
        CoreError::InvalidConfig(tr!(
            "PostgreSQL needs a username",
            "PostgreSQL necesita un usuario"
        ))
    })?;
    let (host, port) = match endpoint {
        Some((host, port)) => (host.as_str(), *port),
        None => (config.host.as_deref().unwrap_or("localhost"), config.port.unwrap_or(5432)),
    };
    let mut options = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .database(&config.database)
        .application_name("gridl")
        .ssl_mode(pg_ssl_mode(config.tls.mode));
    if config.read_only {
        // Enforced by the server, so SQL typed in the editor cannot write either.
        options = options.options([("default_transaction_read_only", "on")]);
    }
    if let Some(secret) = password {
        options = options.password(secret.expose());
    }
    if let Some(path) = &config.tls.root_cert {
        options = options.ssl_root_cert(path);
    }
    if let Some(path) = &config.tls.client_cert {
        options = options.ssl_client_cert(path);
    }
    if let Some(path) = &config.tls.client_key {
        options = options.ssl_client_key(path);
    }
    Ok(options)
}

fn pg_ssl_mode(mode: TlsMode) -> PgSslMode {
    match mode {
        TlsMode::Disable => PgSslMode::Disable,
        TlsMode::Prefer => PgSslMode::Prefer,
        TlsMode::Require => PgSslMode::Require,
        TlsMode::VerifyCa => PgSslMode::VerifyCa,
        TlsMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

fn relation_from_row(row: &PgRow) -> Result<RelationRef, CoreError> {
    let schema: String = row.try_get("table_schema").map_err(db_err)?;
    let name: String = row.try_get("table_name").map_err(db_err)?;
    let kind: String = row.try_get("table_type").map_err(db_err)?;
    Ok(RelationRef { schema: Some(schema), name, kind: relation_kind(&kind) })
}

fn relation_kind(table_type: &str) -> RelationKind {
    match table_type {
        "VIEW" => RelationKind::View,
        "MATERIALIZED VIEW" => RelationKind::Materialized,
        _ => RelationKind::Table,
    }
}

async fn catalog_objects(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let mut objects = routines(pool).await?;
    objects.extend(sequences(pool).await?);
    objects.extend(triggers(pool).await?);
    objects.extend(indexes(pool).await?);
    Ok(objects)
}

async fn routines(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT n.nspname AS schema_name,
                p.proname AS object_name,
                CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS object_kind,
                pg_get_function_identity_arguments(p.oid) AS identity_args,
                CASE
                    WHEN p.prokind = 'a' THEN NULL
                    ELSE pg_get_functiondef(p.oid)
                END AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
           AND p.prokind IN ('f', 'p', 'a', 'w')
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter().map(routine_from_row).collect()
}

fn routine_from_row(row: &PgRow) -> Result<TableSchema, CoreError> {
    let kind: String = row.try_get("object_kind").map_err(db_err)?;
    let args: String = row.try_get("identity_args").map_err(db_err)?;
    Ok(TableSchema {
        schema: Some(row.try_get("schema_name").map_err(db_err)?),
        name: row.try_get("object_name").map_err(db_err)?,
        kind: if kind == "procedure" { RelationKind::Procedure } else { RelationKind::Function },
        columns: argument_columns(&args),
        definition: row.try_get("definition").map_err(db_err)?,
    })
}

async fn sequences(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT sequence_schema, sequence_name, data_type
         FROM information_schema.sequences
         WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema')
           AND sequence_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let data_type: String = row.try_get("data_type").map_err(db_err)?;
            Ok(TableSchema {
                schema: Some(row.try_get("sequence_schema").map_err(db_err)?),
                name: row.try_get("sequence_name").map_err(db_err)?,
                kind: RelationKind::Sequence,
                columns: vec![plain_column("tipo", &data_type)],
                definition: None,
            })
        })
        .collect()
}

async fn triggers(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT n.nspname AS schema_name,
                t.tgname AS object_name,
                pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(TableSchema {
                schema: Some(row.try_get("schema_name").map_err(db_err)?),
                name: row.try_get("object_name").map_err(db_err)?,
                kind: RelationKind::Trigger,
                columns: Vec::new(),
                definition: row.try_get("definition").map_err(db_err)?,
            })
        })
        .collect()
}

async fn indexes(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let rows = sqlx::query(
        "SELECT schemaname, indexname, indexdef
         FROM pg_indexes
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
           AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(TableSchema {
                schema: Some(row.try_get("schemaname").map_err(db_err)?),
                name: row.try_get("indexname").map_err(db_err)?,
                kind: RelationKind::Index,
                columns: Vec::new(),
                definition: row.try_get("indexdef").map_err(db_err)?,
            })
        })
        .collect()
}

fn argument_columns(args: &str) -> Vec<ColumnDefinition> {
    split_args(args)
        .into_iter()
        .enumerate()
        .filter_map(|(index, part)| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, data_type) = split_argument(part, index);
            Some(plain_column(&name, &data_type))
        })
        .collect()
}

fn split_args(args: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut depth: i32 = 0;
    for (index, char) in args.char_indices() {
        match char {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(&args[start..index]);
                start = index + char.len_utf8();
            }
            _ => {}
        }
    }
    if start < args.len() {
        parts.push(&args[start..]);
    }
    parts
}

fn split_argument(part: &str, index: usize) -> (String, String) {
    let stripped = part
        .strip_prefix("VARIADIC ")
        .or_else(|| part.strip_prefix("INOUT "))
        .or_else(|| part.strip_prefix("OUT "))
        .or_else(|| part.strip_prefix("IN "))
        .unwrap_or(part)
        .trim();
    let Some((name, data_type)) = stripped.split_once(char::is_whitespace) else {
        return (format!("arg{}", index + 1), stripped.to_owned());
    };
    if is_type_word(name) {
        return (format!("arg{}", index + 1), stripped.to_owned());
    }
    (name.to_owned(), data_type.trim().to_owned())
}

fn is_type_word(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "bigint"
            | "boolean"
            | "bool"
            | "bytea"
            | "character"
            | "date"
            | "decimal"
            | "double"
            | "float"
            | "int"
            | "int2"
            | "int4"
            | "int8"
            | "integer"
            | "interval"
            | "json"
            | "jsonb"
            | "numeric"
            | "real"
            | "smallint"
            | "text"
            | "time"
            | "timestamp"
            | "uuid"
            | "varchar"
            | "xml"
    )
}

fn plain_column(name: &str, data_type: &str) -> ColumnDefinition {
    ColumnDefinition {
        name: name.to_owned(),
        data_type: data_type.to_owned(),
        nullable: true,
        primary_key: false,
        default_value: None,
        options: Vec::new(),
    }
}

async fn primary_keys(
    pool: &PgPool,
    only: Option<(&str, &str)>,
) -> Result<HashSet<(String, String, String)>, CoreError> {
    let rows = match only {
        Some((schema, table)) => sqlx::query(
            "SELECT tc.table_schema, tc.table_name, kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema = $1
                   AND tc.table_name = $2",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(db_err)?,
        None => sqlx::query(
            "SELECT tc.table_schema, tc.table_name, kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')",
        )
        .fetch_all(pool)
        .await
        .map_err(db_err)?,
    };
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("table_schema").map_err(db_err)?,
                row.try_get::<String, _>("table_name").map_err(db_err)?,
                row.try_get::<String, _>("column_name").map_err(db_err)?,
            ))
        })
        .collect()
}

fn column_from_row(
    row: &PgRow,
    schema: &str,
    table: &str,
    keys: &HashSet<(String, String, String)>,
    enums: &HashMap<(String, String), Vec<String>>,
) -> Result<ColumnDefinition, CoreError> {
    let name: String = row.try_get("column_name").map_err(db_err)?;
    let mut data_type: String = row.try_get("data_type").map_err(db_err)?;
    let udt_schema: String = row.try_get("udt_schema").map_err(db_err)?;
    let udt_name: String = row.try_get("udt_name").map_err(db_err)?;
    let nullable: String = row.try_get("is_nullable").map_err(db_err)?;
    let default_value: Option<String> = row.try_get("column_default").map_err(db_err)?;
    let options = enums.get(&(udt_schema.clone(), udt_name.clone())).cloned().unwrap_or_default();
    // format_type spells the declared type in full, as psql shows it: character(5), bit(4),
    // numeric(12,2), integer[], billing.status. Edits cast to it, so a length must not be lost.
    let full_type: Option<String> = row.try_get("full_type").map_err(db_err)?;
    if let Some(full_type) = full_type.filter(|full| !full.is_empty()) {
        data_type = full_type;
    } else if !options.is_empty() || data_type == "USER-DEFINED" {
        // Extension and custom types (hstore, geometry, enums) by their real name.
        data_type = enum_type_name(&udt_schema, &udt_name);
    } else if data_type == "ARRAY" {
        // information_schema says only "ARRAY"; udt_name is the element type with a leading underscore.
        let element = udt_name.strip_prefix('_').unwrap_or(&udt_name);
        data_type = format!("{}[]", enum_type_name(&udt_schema, element));
    }
    Ok(ColumnDefinition {
        primary_key: keys.contains(&(schema.to_owned(), table.to_owned(), name.clone())),
        name,
        data_type,
        nullable: nullable.eq_ignore_ascii_case("YES"),
        default_value,
        options,
    })
}

async fn enum_labels(pool: &PgPool) -> Result<HashMap<(String, String), Vec<String>>, CoreError> {
    let rows = sqlx::query(
        "SELECT n.nspname AS type_schema, t.typname AS type_name, e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         ORDER BY e.enumtypid, e.enumsortorder",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut labels: HashMap<(String, String), Vec<String>> = HashMap::new();
    for row in &rows {
        let schema: String = row.try_get("type_schema").map_err(db_err)?;
        let name: String = row.try_get("type_name").map_err(db_err)?;
        let label: String = row.try_get("label").map_err(db_err)?;
        labels.entry((schema, name)).or_default().push(label);
    }
    Ok(labels)
}

fn enum_type_name(schema: &str, name: &str) -> String {
    if schema.is_empty() || schema == "public" || schema == "pg_catalog" {
        name.to_owned()
    } else {
        format!("{schema}.{name}")
    }
}

fn attach_enum_options(
    columns: &mut [ColumnDefinition],
    enums: &HashMap<(String, String), Vec<String>>,
) {
    let mut by_name: HashMap<String, Vec<(String, Vec<String>)>> = HashMap::new();
    for ((schema, name), labels) in enums {
        by_name.entry(name.clone()).or_default().push((schema.clone(), labels.clone()));
    }
    for column in columns.iter_mut() {
        if !column.options.is_empty() {
            continue;
        }
        let Some((type_name, matches)) =
            by_name.iter().find(|(name, _)| name.eq_ignore_ascii_case(&column.data_type))
        else {
            continue;
        };
        if matches.len() != 1 {
            continue;
        }
        let (schema, labels) = &matches[0];
        column.data_type = enum_type_name(schema, type_name);
        column.options.clone_from(labels);
    }
}

async fn statement_columns(
    connection: &mut PoolConnection<Postgres>,
    sql: &str,
    params: &[SqlValue],
    enums: &EnumLabels,
) -> Result<Vec<ColumnDefinition>, CoreError> {
    // Declare the parameters as the types `pg_query` encodes them with. Left to
    // inference, `id = $1` makes $1 an int4 and the int8 sent later is rejected.
    let types: Vec<PgTypeInfo> = params.iter().map(param_type).collect();
    let statement = connection.prepare_with(sql, &types).await.map_err(db_err)?;
    let mut columns = column_defs(statement.columns());
    attach_enum_options(&mut columns, enums);
    Ok(columns)
}

fn param_type(param: &SqlValue) -> PgTypeInfo {
    match param {
        SqlValue::Null | SqlValue::Int(_) => <i64 as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Bool(_) => <bool as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Float(_) => <f64 as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Text(_) => <&str as sqlx::Type<Postgres>>::type_info(),
        SqlValue::Bytes(_) => <&[u8] as sqlx::Type<Postgres>>::type_info(),
    }
}

fn pg_query<'q>(
    sql: &'q str,
    params: &'q [SqlValue],
) -> Result<sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>, CoreError> {
    let mut args = sqlx::postgres::PgArguments::default();
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

fn decode_pg_row(row: &PgRow) -> Vec<SqlValue> {
    (0..row.columns().len()).map(|index| decode_pg_cell(row, index)).collect()
}

fn decode_pg_cell(row: &PgRow, index: usize) -> SqlValue {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return SqlValue::Text("<unreadable>".into()),
    };
    if raw.is_null() {
        return SqlValue::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    match (raw.format(), raw.as_bytes().map(std::str::from_utf8)) {
        (PgValueFormat::Text, Ok(Ok(text))) => decode_pg_text(&type_name, text),
        // Reads always use the simple protocol, so binary values should not arrive here.
        _ => SqlValue::Text(format!("<{type_name}>")),
    }
}

/// A value in text format, as PostgreSQL's output function wrote it. Numbers and
/// booleans become typed values so the grid can align and edit them; everything
/// else is shown exactly as psql would show it.
fn decode_pg_text(type_name: &str, text: &str) -> SqlValue {
    match type_name {
        "BOOL" => match text {
            "t" => SqlValue::Bool(true),
            "f" => SqlValue::Bool(false),
            _ => cap_text(text.to_owned()),
        },
        "INT2" | "INT4" | "INT8" | "OID" => {
            text.parse::<i64>().map_or_else(|_| cap_text(text.to_owned()), SqlValue::Int)
        }
        "FLOAT4" | "FLOAT8" => match text.parse::<f64>() {
            Ok(value) if value.is_finite() => SqlValue::Float(value),
            _ => SqlValue::Text(text.to_owned()),
        },
        "BYTEA" => match text.strip_prefix("\\x").and_then(hex_bytes) {
            Some(bytes) => cap_bytes(bytes),
            None => cap_text(text.to_owned()),
        },
        _ => cap_text(text.to_owned()),
    }
}

fn hex_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()).collect()
}

/// Writes `$1`, `$2`… as SQL literals so a query with parameters can still run over
/// the simple protocol and come back as text. Placeholders inside strings, quoted
/// identifiers, comments, and dollar-quoted bodies are left alone.
fn inline_params(sql: &str, params: &[SqlValue]) -> Result<String, CoreError> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        match c {
            '\'' => {
                let escapes = at > 0
                    && matches!(chars[at - 1], 'e' | 'E')
                    && !chars
                        .get(at.wrapping_sub(2))
                        .is_some_and(|p| p.is_alphanumeric() || *p == '_');
                let start = at;
                at += 1;
                while at < chars.len() {
                    if escapes && chars[at] == '\\' {
                        at += 2;
                        continue;
                    }
                    if chars[at] == '\'' {
                        if chars.get(at + 1) == Some(&'\'') {
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
            '"' => {
                let start = at;
                at += 1;
                while at < chars.len() && !(chars[at] == '"' && chars.get(at + 1) != Some(&'"')) {
                    at += if chars[at] == '"' { 2 } else { 1 };
                }
                at = (at + 1).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '-' if next == Some('-') => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '/' if next == Some('*') => {
                let start = at;
                let mut depth = 0;
                while at < chars.len() {
                    if chars[at] == '/' && chars.get(at + 1) == Some(&'*') {
                        depth += 1;
                        at += 2;
                    } else if chars[at] == '*' && chars.get(at + 1) == Some(&'/') {
                        depth -= 1;
                        at += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        at += 1;
                    }
                }
                out.extend(&chars[start..at.min(chars.len())]);
            }
            '$' => {
                let follows_word = at > 0
                    && (chars[at - 1].is_alphanumeric()
                        || chars[at - 1] == '_'
                        || chars[at - 1] == '$');
                if !follows_word && next.is_some_and(|n| n.is_ascii_digit()) {
                    let start = at + 1;
                    let mut end = start;
                    while end < chars.len() && chars[end].is_ascii_digit() {
                        end += 1;
                    }
                    let number: String = chars[start..end].iter().collect();
                    let index = number
                        .parse::<usize>()
                        .ok()
                        .filter(|n| *n >= 1 && *n <= params.len())
                        .ok_or_else(|| {
                            CoreError::Database(tr!(
                                "there is no parameter ${number}",
                                "no existe el parámetro ${number}"
                            ))
                        })?;
                    out.push_str(&sql_literal(&params[index - 1]));
                    at = end;
                    continue;
                }
                // A dollar-quoted body: $tag$ … $tag$.
                let mut end = at + 1;
                while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                    end += 1;
                }
                if !follows_word && chars.get(end) == Some(&'$') {
                    let tag: String = chars[at..=end].iter().collect();
                    let body_start = end + 1;
                    let rest: String = chars[body_start..].iter().collect();
                    let close = rest.find(&tag).map_or(chars.len(), |offset| {
                        body_start + rest[..offset].chars().count() + tag.chars().count()
                    });
                    out.extend(&chars[at..close]);
                    at = close;
                } else {
                    out.push(c);
                    at += 1;
                }
            }
            _ => {
                out.push(c);
                at += 1;
            }
        }
    }
    Ok(out)
}

/// A literal PostgreSQL reads the way it would read the bound value: strings stay
/// untyped so they take the type the context gives them, exactly like a parameter.
fn sql_literal(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "NULL".into(),
        SqlValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
        SqlValue::Int(value) if *value < 0 => format!("({value})"),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) if value.is_nan() => "'NaN'::float8".into(),
        SqlValue::Float(value) if value.is_infinite() => {
            if *value > 0.0 {
                "'Infinity'::float8".into()
            } else {
                "'-Infinity'::float8".into()
            }
        }
        SqlValue::Float(value) if *value < 0.0 => format!("({value:?})"),
        SqlValue::Float(value) => format!("{value:?}"),
        SqlValue::Text(text) => format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "\\'")),
        SqlValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("E'\\\\x{hex}'::bytea")
        }
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
    use super::{inline_params, sql_literal};
    use crate::value::SqlValue;

    #[test]
    fn inlines_placeholders_outside_strings_comments_and_bodies() {
        let params = [SqlValue::Int(-5), SqlValue::Text("it's a \\ test".into())];
        let sql = "select $1, '$1', E'\\'$2', \"$1\", $2 -- $1\n/* $2 /* $1 */ */ $$ $1 $$, $q$ $2 $q$, x$1";
        assert_eq!(
            inline_params(sql, &params).expect("inline"),
            "select (-5), '$1', E'\\'$2', \"$1\", E'it\\'s a \\\\ test' -- $1\n/* $2 /* $1 */ */ $$ $1 $$, $q$ $2 $q$, x$1"
        );
        assert!(inline_params("select $3", &params).is_err());
    }

    #[test]
    fn literals_read_back_as_the_bound_value() {
        assert_eq!(sql_literal(&SqlValue::Null), "NULL");
        assert_eq!(sql_literal(&SqlValue::Bool(true)), "TRUE");
        assert_eq!(sql_literal(&SqlValue::Float(-1.5)), "(-1.5)");
        assert_eq!(sql_literal(&SqlValue::Float(f64::NAN)), "'NaN'::float8");
        assert_eq!(sql_literal(&SqlValue::Bytes(vec![0xde, 0xad])), "E'\\\\xdead'::bytea");
    }
}

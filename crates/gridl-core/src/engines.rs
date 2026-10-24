//! What makes each database engine different, written down as data.
//!
//! Every engine Gridl supports has one [`EngineSpec`]: how to connect, how its
//! SQL is spelled, which column types the structure editor offers and what it
//! can do. The app reads these specs instead of asking "is this MySQL?" all
//! over the code. They serialize to JSON, which is also the shape a future
//! external engine plugin will hand over.
//!
//! Adding an engine: a variant of [`DatabaseEngine`], a driver implementing
//! [`crate::DatabaseDriver`], and its spec in [`builtin_specs`]. See
//! `docs/adding-an-engine.md`.

use serde::Serialize;

use crate::DatabaseEngine;

/// Everything the app needs to know about an engine besides its driver.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSpec {
    /// Matches `DatabaseEngine` in saved profiles: "postgres", "mysql", "sqlite".
    pub id: &'static str,
    pub name: &'static str,
    /// Two letters for the engine badge.
    pub short: &'static str,
    /// Badge color.
    pub color: &'static str,
    pub connection: ConnectionSpec,
    pub sql: SqlSpec,
    pub structure: StructureSpec,
    pub tools: ToolSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpec {
    /// The database is a file on disk rather than a server (no host, port, TLS or SSH).
    pub file_based: bool,
    pub default_port: Option<u16>,
    pub default_user: Option<&'static str>,
    /// Shown as the connection name of a new profile.
    pub default_name: &'static str,
    /// Extensions offered when picking the database file of a file-based engine.
    pub file_extensions: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSpec {
    /// Quotes identifiers: `"` or a backtick.
    pub identifier_quote: char,
    /// Bound parameters: `$1, $2…` ("dollar") or `?` ("question").
    pub params: ParamStyle,
    /// Bound text parameters need a cast to the column type (PostgreSQL).
    pub param_casts: bool,
    /// Language of the editor, the formatter and the highlighter.
    pub dialect: SqlDialect,
    /// Backslash escapes inside string literals (MySQL without NO_BACKSLASH_ESCAPES).
    pub backslash_escapes: bool,
    /// `#` starts a comment (MySQL).
    pub hash_comments: bool,
    /// `$tag$ … $tag$` string bodies (PostgreSQL).
    pub dollar_quotes: bool,
    /// Type name for `CAST(x AS …)` to text.
    pub text_cast: &'static str,
    /// How "these two values differ, NULLs included" is written.
    pub null_safe_differs: NullSafeDiffers,
    /// How a "contains" filter matches text.
    pub contains: ContainsMatch,
    pub booleans: BooleanLiteral,
    pub bytes: BytesLiteral,
    /// Insert of a row with every column at its default.
    pub empty_insert: &'static str,
    /// Current date, time and timestamp, for the NOW() shortcut in the grid.
    pub now: [&'static str; 3],
    /// OUT parameters of a procedure call are passed as session variables (MySQL).
    pub out_param_variables: bool,
    /// Text literals are written N'…' so they keep characters outside the code page (SQL Server).
    pub national_text: bool,
    /// How a page of rows is asked for.
    pub paging: Paging,
    /// How a procedure is called.
    pub procedure_call: ProcedureCall,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Paging {
    /// `LIMIT n OFFSET m`
    LimitOffset,
    /// `ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY`
    OffsetFetch,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcedureCall {
    /// `CALL p(a, b)`
    Call,
    /// `EXEC p @a = …, @b = … OUTPUT`
    Exec,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParamStyle {
    Dollar,
    Question,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SqlDialect {
    Postgresql,
    Mysql,
    Sqlite,
    Transactsql,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NullSafeDiffers {
    /// `a IS DISTINCT FROM b`
    IsDistinctFrom,
    /// `NOT (a <=> b)`
    NotNullSafeEquals,
    /// `a IS NOT b`
    IsNot,
    /// `EXISTS (SELECT a EXCEPT SELECT b)`, for servers without IS DISTINCT FROM
    ExistsExcept,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContainsMatch {
    /// `cast(c as text) ilike '…' escape '\'`
    IlikeText,
    /// `c like '…' escape '\'`
    LikeEscape,
    /// `c like '…'`, backslash already escapes
    Like,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BooleanLiteral {
    /// TRUE / FALSE
    Keyword,
    /// 1 / 0
    Number,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BytesLiteral {
    /// '\xCAFE'
    EscapedHex,
    /// X'CAFE'
    XHex,
    /// 0xCAFE
    PrefixedHex,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSpec {
    /// Objects live in schemas the explorer groups by (PostgreSQL).
    pub schemas: bool,
    /// Which built-in strategy writes ALTER TABLE statements.
    pub ddl: DdlStyle,
    /// Column types the structure editor offers.
    pub column_types: Vec<ColumnType>,
    /// The type a new table's key column gets.
    pub key_type: &'static str,
    /// Length suggested for a type that takes one.
    pub length_hint: Option<&'static str>,
    /// Type a column needs to reference another: (regex on the referenced type, type to use).
    pub reference_rules: Vec<(&'static str, &'static str)>,
    /// Type used when no rule or same-named type fits.
    pub reference_fallback: Option<&'static str>,
    /// Existing columns can change type, nullability and default (else only rename, add, drop).
    pub alter_columns: bool,
    /// UNIQUE allowed when adding a column.
    pub unique_on_add: bool,
    /// Foreign keys can be added to or dropped from existing tables.
    pub alter_foreign_keys: bool,
    /// Words that drop a foreign key: "drop constraint" or "drop foreign key".
    pub drop_foreign_key: &'static str,
    /// Lists the user's schemas, one name per row (engines with schemas).
    pub list_schemas: Option<&'static str>,
    /// A schema can be renamed.
    pub rename_schemas: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DdlStyle {
    Postgres,
    Mysql,
    Sqlite,
    Sqlserver,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnType {
    pub name: &'static str,
    pub kind: SizeKind,
    /// The database fills it (serial).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub generated: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SizeKind {
    Plain,
    Length,
    Numeric,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    /// How a query plan is asked for and read; none hides the Plan button.
    pub explain: Option<ExplainStyle>,
    /// Where a table's row estimate comes from; none always counts.
    pub row_estimate: Option<RowEstimate>,
    /// Which tool writes a backup.
    pub backup: Option<BackupTool>,
    /// A backup can be restored from the app.
    pub restore: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExplainStyle {
    PostgresJson,
    MysqlJson,
    SqliteQueryPlan,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RowEstimate {
    PgClass,
    InformationSchema,
    SysPartitions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupTool {
    PgDump,
    Mysqldump,
    VacuumInto,
}

const fn plain(name: &'static str) -> ColumnType {
    ColumnType { name, kind: SizeKind::Plain, generated: false }
}
const fn length(name: &'static str) -> ColumnType {
    ColumnType { name, kind: SizeKind::Length, generated: false }
}
const fn numeric(name: &'static str) -> ColumnType {
    ColumnType { name, kind: SizeKind::Numeric, generated: false }
}
const fn generated(name: &'static str) -> ColumnType {
    ColumnType { name, kind: SizeKind::Plain, generated: true }
}

/// The spec of one engine.
pub fn spec(engine: DatabaseEngine) -> EngineSpec {
    match engine {
        DatabaseEngine::Postgres => postgres(),
        DatabaseEngine::Mysql => mysql(),
        DatabaseEngine::Sqlite => sqlite(),
        DatabaseEngine::Sqlserver => sqlserver(),
    }
}

/// Every engine built into this app, in the order the app offers them.
pub fn builtin_specs() -> Vec<EngineSpec> {
    vec![postgres(), mysql(), sqlite(), sqlserver()]
}

fn postgres() -> EngineSpec {
    EngineSpec {
        id: "postgres",
        name: "PostgreSQL",
        short: "Pg",
        color: "#3b82f6",
        connection: ConnectionSpec {
            file_based: false,
            default_port: Some(5432),
            default_user: Some("postgres"),
            default_name: "PostgreSQL",
            file_extensions: Vec::new(),
        },
        sql: SqlSpec {
            identifier_quote: '"',
            params: ParamStyle::Dollar,
            param_casts: true,
            dialect: SqlDialect::Postgresql,
            backslash_escapes: false,
            hash_comments: false,
            dollar_quotes: true,
            text_cast: "TEXT",
            null_safe_differs: NullSafeDiffers::IsDistinctFrom,
            contains: ContainsMatch::IlikeText,
            booleans: BooleanLiteral::Keyword,
            bytes: BytesLiteral::EscapedHex,
            empty_insert: "default values",
            now: ["current_date", "current_time", "now()"],
            out_param_variables: false,
            national_text: false,
            paging: Paging::LimitOffset,
            procedure_call: ProcedureCall::Call,
        },
        structure: StructureSpec {
            schemas: true,
            ddl: DdlStyle::Postgres,
            column_types: vec![
                plain("text"),
                length("varchar"),
                length("char"),
                plain("smallint"),
                plain("integer"),
                plain("bigint"),
                generated("serial"),
                generated("bigserial"),
                plain("boolean"),
                numeric("numeric"),
                plain("real"),
                plain("double precision"),
                plain("date"),
                plain("time"),
                plain("timestamp"),
                plain("timestamptz"),
                plain("interval"),
                plain("uuid"),
                plain("json"),
                plain("jsonb"),
                plain("bytea"),
            ],
            key_type: "serial",
            length_hint: None,
            reference_rules: vec![
                ("^(serial|integer|int4)$", "integer"),
                ("^(bigserial|bigint|int8)$", "bigint"),
                ("^(smallserial|smallint)$", "smallint"),
                ("^character varying", "varchar"),
            ],
            reference_fallback: None,
            alter_columns: true,
            unique_on_add: true,
            alter_foreign_keys: true,
            drop_foreign_key: "drop constraint",
            list_schemas: Some(
                "select schema_name
from information_schema.schemata
where schema_name not in ('pg_catalog', 'information_schema')
  and schema_name not like 'pg\\_%' escape '\\'
order by schema_name",
            ),
            rename_schemas: true,
        },
        tools: ToolSpec {
            explain: Some(ExplainStyle::PostgresJson),
            row_estimate: Some(RowEstimate::PgClass),
            backup: Some(BackupTool::PgDump),
            restore: true,
        },
    }
}

fn mysql() -> EngineSpec {
    EngineSpec {
        id: "mysql",
        name: "MySQL / MariaDB",
        short: "My",
        color: "#f59e0b",
        connection: ConnectionSpec {
            file_based: false,
            default_port: Some(3306),
            default_user: Some("root"),
            default_name: "MySQL",
            file_extensions: Vec::new(),
        },
        sql: SqlSpec {
            identifier_quote: '`',
            params: ParamStyle::Question,
            param_casts: false,
            dialect: SqlDialect::Mysql,
            backslash_escapes: true,
            hash_comments: true,
            dollar_quotes: false,
            text_cast: "CHAR",
            null_safe_differs: NullSafeDiffers::NotNullSafeEquals,
            contains: ContainsMatch::Like,
            booleans: BooleanLiteral::Keyword,
            bytes: BytesLiteral::XHex,
            empty_insert: "() values ()",
            now: ["current_date", "current_time", "now()"],
            out_param_variables: true,
            national_text: false,
            paging: Paging::LimitOffset,
            procedure_call: ProcedureCall::Call,
        },
        structure: StructureSpec {
            schemas: false,
            ddl: DdlStyle::Mysql,
            column_types: vec![
                length("varchar"),
                length("char"),
                plain("text"),
                plain("mediumtext"),
                plain("longtext"),
                plain("tinyint"),
                plain("smallint"),
                plain("int"),
                plain("bigint"),
                plain("bigint unsigned"),
                generated("serial"),
                plain("boolean"),
                numeric("decimal"),
                plain("float"),
                plain("double"),
                plain("date"),
                plain("time"),
                plain("datetime"),
                plain("timestamp"),
                plain("json"),
                plain("blob"),
                plain("longblob"),
            ],
            key_type: "serial",
            length_hint: Some("255"),
            reference_rules: vec![("^(serial|bigint( ?\\(20\\))? unsigned)", "bigint unsigned")],
            reference_fallback: None,
            alter_columns: true,
            unique_on_add: true,
            alter_foreign_keys: true,
            drop_foreign_key: "drop foreign key",
            list_schemas: None,
            rename_schemas: false,
        },
        tools: ToolSpec {
            explain: Some(ExplainStyle::MysqlJson),
            row_estimate: Some(RowEstimate::InformationSchema),
            backup: Some(BackupTool::Mysqldump),
            restore: true,
        },
    }
}

fn sqlite() -> EngineSpec {
    EngineSpec {
        id: "sqlite",
        name: "SQLite",
        short: "Sl",
        color: "#8b5cf6",
        connection: ConnectionSpec {
            file_based: true,
            default_port: None,
            default_user: None,
            default_name: "SQLite",
            file_extensions: vec!["sqlite", "sqlite3", "db"],
        },
        sql: SqlSpec {
            identifier_quote: '"',
            params: ParamStyle::Question,
            param_casts: false,
            dialect: SqlDialect::Sqlite,
            backslash_escapes: false,
            hash_comments: false,
            dollar_quotes: false,
            text_cast: "TEXT",
            null_safe_differs: NullSafeDiffers::IsNot,
            contains: ContainsMatch::LikeEscape,
            booleans: BooleanLiteral::Number,
            bytes: BytesLiteral::XHex,
            empty_insert: "default values",
            now: ["date('now')", "time('now')", "datetime('now')"],
            out_param_variables: false,
            national_text: false,
            paging: Paging::LimitOffset,
            procedure_call: ProcedureCall::Call,
        },
        structure: StructureSpec {
            schemas: false,
            ddl: DdlStyle::Sqlite,
            column_types: vec![
                plain("TEXT"),
                plain("INTEGER"),
                plain("REAL"),
                plain("NUMERIC"),
                plain("BLOB"),
            ],
            key_type: "INTEGER",
            length_hint: None,
            reference_rules: Vec::new(),
            reference_fallback: Some("INTEGER"),
            alter_columns: false,
            unique_on_add: false,
            alter_foreign_keys: false,
            drop_foreign_key: "drop constraint",
            list_schemas: None,
            rename_schemas: false,
        },
        tools: ToolSpec {
            explain: Some(ExplainStyle::SqliteQueryPlan),
            row_estimate: None,
            backup: Some(BackupTool::VacuumInto),
            restore: false,
        },
    }
}

fn sqlserver() -> EngineSpec {
    EngineSpec {
        id: "sqlserver",
        name: "SQL Server",
        short: "Ms",
        color: "#ef4444",
        connection: ConnectionSpec {
            file_based: false,
            default_port: Some(1433),
            default_user: Some("sa"),
            default_name: "SQL Server",
            file_extensions: Vec::new(),
        },
        sql: SqlSpec {
            // The driver turns QUOTED_IDENTIFIER on, so "x" works like [x].
            identifier_quote: '"',
            // The driver numbers them @P1, @P2… for the server.
            params: ParamStyle::Question,
            param_casts: false,
            dialect: SqlDialect::Transactsql,
            backslash_escapes: false,
            hash_comments: false,
            dollar_quotes: false,
            text_cast: "NVARCHAR(MAX)",
            null_safe_differs: NullSafeDiffers::ExistsExcept,
            contains: ContainsMatch::LikeEscape,
            booleans: BooleanLiteral::Number,
            bytes: BytesLiteral::PrefixedHex,
            empty_insert: "default values",
            now: ["cast(sysdatetime() as date)", "cast(sysdatetime() as time)", "sysdatetime()"],
            out_param_variables: false,
            national_text: true,
            paging: Paging::OffsetFetch,
            procedure_call: ProcedureCall::Exec,
        },
        structure: StructureSpec {
            schemas: true,
            ddl: DdlStyle::Sqlserver,
            column_types: vec![
                length("nvarchar"),
                plain("nvarchar(max)"),
                length("varchar"),
                plain("varchar(max)"),
                length("nchar"),
                length("char"),
                plain("tinyint"),
                plain("smallint"),
                plain("int"),
                plain("bigint"),
                generated("int identity"),
                generated("bigint identity"),
                plain("bit"),
                numeric("decimal"),
                plain("money"),
                plain("real"),
                plain("float"),
                plain("date"),
                plain("time"),
                plain("datetime2"),
                plain("datetimeoffset"),
                plain("datetime"),
                plain("uniqueidentifier"),
                length("varbinary"),
                plain("varbinary(max)"),
                plain("xml"),
            ],
            key_type: "int identity",
            // Without a length nvarchar holds one character.
            length_hint: Some("255"),
            reference_rules: vec![("^int( identity)?$", "int"), ("^bigint( identity)?$", "bigint")],
            reference_fallback: None,
            alter_columns: true,
            unique_on_add: true,
            alter_foreign_keys: true,
            drop_foreign_key: "drop constraint",
            // Role schemas (db_owner…) have ids from 16384.
            list_schemas: Some(
                "select name from sys.schemas
where schema_id < 16384 and name not in ('sys', 'INFORMATION_SCHEMA', 'guest')
order by name",
            ),
            rename_schemas: false,
        },
        tools: ToolSpec {
            explain: None,
            row_estimate: Some(RowEstimate::SysPartitions),
            // BACKUP DATABASE writes on the server's disk, not the user's.
            backup: None,
            restore: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend ships a copy of these specs for its first paint and its tests.
    /// `GRIDL_WRITE_ENGINES=1 cargo test -p gridl-core engines` rewrites it.
    #[test]
    fn frontend_copy_matches_the_specs() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../frontend/src/engines/builtin.json");
        let json = format!("{}\n", serde_json::to_string_pretty(&builtin_specs()).expect("json"));
        if std::env::var_os("GRIDL_WRITE_ENGINES").is_some() {
            std::fs::write(&path, &json).expect("write builtin.json");
        }
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(current == json, "frontend/src/engines/builtin.json is out of date: run GRIDL_WRITE_ENGINES=1 cargo test -p gridl-core engines");
    }

    #[test]
    fn every_engine_has_its_spec() {
        for engine in [
            DatabaseEngine::Postgres,
            DatabaseEngine::Mysql,
            DatabaseEngine::Sqlite,
            DatabaseEngine::Sqlserver,
        ] {
            let id = serde_json::to_value(engine).expect("engine id");
            assert_eq!(id, spec(engine).id);
        }
    }
}

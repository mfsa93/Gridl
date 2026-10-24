//! Routines, sequences, triggers and indexes, for the explorer.

use sqlx::postgres::PgPool;

use super::catalog::get;
use crate::drivers::common::catalog::{plain_column, table_object, TableFilter};
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, RelationKind, TableSchema};

/// Leaves out the system schemas, which the explorer never shows.
fn user_schemas(column: &str) -> String {
    format!(
        "{column} NOT IN ('pg_catalog', 'information_schema') AND {column} NOT LIKE 'pg\\_%' ESCAPE '\\'"
    )
}

pub(super) async fn all(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let (mut objects, sequences, attached) =
        tokio::try_join!(routines(pool), sequences(pool), table_objects(pool, None))?;
    objects.extend(sequences);
    objects.extend(attached);
    Ok(objects)
}

async fn routines(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let sql = format!(
        "SELECT n.nspname AS schema_name,
                p.proname AS object_name,
                CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS object_kind,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'name', COALESCE(NULLIF(p.proargnames[a.ord], ''), 'arg' || a.ord),
                        'type', pg_catalog.format_type(a.typ, NULL),
                        'mode', CASE p.proargmodes[a.ord]
                            WHEN 'o' THEN 'OUT' WHEN 'b' THEN 'INOUT' WHEN 'v' THEN 'VARIADIC' ELSE 'IN' END,
                        'default', pg_get_function_arg_default(p.oid, a.ord::int)
                    ) ORDER BY a.ord)
                    FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS a(typ, ord)
                    -- 't' marks the columns of RETURNS TABLE, which are results, not parameters.
                    WHERE COALESCE(p.proargmodes[a.ord], 'i') <> 't'
                ), '[]')::text AS arguments,
                CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS result_type,
                CASE WHEN p.prokind = 'a' THEN NULL ELSE pg_get_functiondef(p.oid) END AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE {} AND p.prokind IN ('f', 'p', 'a', 'w')
         ORDER BY 1, 2",
        user_schemas("n.nspname")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await.map_err(db_err)?;
    rows.iter()
        .map(|row| {
            let procedure = get::<String>(row, "object_kind")? == "procedure";
            Ok(TableSchema {
                schema: Some(get(row, "schema_name")?),
                name: get(row, "object_name")?,
                kind: if procedure { RelationKind::Procedure } else { RelationKind::Function },
                columns: arguments(&get::<String>(row, "arguments")?)?,
                definition: get(row, "definition")?,
                returns: get(row, "result_type")?,
                parent: None,
            })
        })
        .collect()
}

/// One routine parameter as the catalog query above describes it.
#[derive(serde::Deserialize)]
struct Argument {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
    mode: String,
    default: Option<String>,
}

fn arguments(json: &str) -> Result<Vec<ColumnDefinition>, CoreError> {
    let arguments: Vec<Argument> = serde_json::from_str(json)
        .map_err(|error| CoreError::Database(format!("routine arguments: {error}")))?;
    Ok(arguments
        .into_iter()
        .map(|argument| ColumnDefinition {
            default_value: argument.default,
            mode: Some(argument.mode),
            ..plain_column(&argument.name, &argument.data_type)
        })
        .collect())
}

async fn sequences(pool: &PgPool) -> Result<Vec<TableSchema>, CoreError> {
    let sql = format!(
        "SELECT sequence_schema, sequence_name, data_type
         FROM information_schema.sequences
         WHERE {}
         ORDER BY 1, 2",
        user_schemas("sequence_schema")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await.map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(TableSchema {
                schema: Some(get(row, "sequence_schema")?),
                name: get(row, "sequence_name")?,
                kind: RelationKind::Sequence,
                columns: vec![plain_column("tipo", &get::<String>(row, "data_type")?)],
                definition: None,
                returns: None,
                parent: None,
            })
        })
        .collect()
}

/// Triggers and indexes of every table, or of `only` one.
pub(super) async fn table_objects(
    pool: &PgPool,
    only: TableFilter<'_>,
) -> Result<Vec<TableSchema>, CoreError> {
    let (mut objects, indexes) = tokio::try_join!(triggers(pool, only), indexes(pool, only))?;
    objects.extend(indexes);
    Ok(objects)
}

/// Binds the schema and table of `only` to `$1` and `$2` when the SQL filters on one.
async fn rows(
    sql: &str,
    only: TableFilter<'_>,
    pool: &PgPool,
) -> Result<Vec<sqlx::postgres::PgRow>, CoreError> {
    let query = sqlx::query(sql);
    let query = match only {
        Some((schema, table)) => query.bind(schema).bind(table),
        None => query,
    };
    query.fetch_all(pool).await.map_err(db_err)
}

async fn triggers(pool: &PgPool, only: TableFilter<'_>) -> Result<Vec<TableSchema>, CoreError> {
    let filter = if only.is_some() { "AND n.nspname = $1 AND c.relname = $2" } else { "" };
    let sql = format!(
        "SELECT n.nspname AS schema_name, t.tgname AS object_name, c.relname AS table_name,
                pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND {} {filter}
         ORDER BY 1, 2",
        user_schemas("n.nspname")
    );
    rows(&sql, only, pool)
        .await?
        .iter()
        .map(|row| {
            Ok(table_object(
                Some(get(row, "schema_name")?),
                get(row, "object_name")?,
                RelationKind::Trigger,
                get(row, "definition")?,
                get(row, "table_name")?,
            ))
        })
        .collect()
}

async fn indexes(pool: &PgPool, only: TableFilter<'_>) -> Result<Vec<TableSchema>, CoreError> {
    let filter = if only.is_some() { "AND schemaname = $1 AND tablename = $2" } else { "" };
    let sql = format!(
        "SELECT schemaname, indexname, tablename, indexdef FROM pg_indexes WHERE {} {filter} ORDER BY 1, 2",
        user_schemas("schemaname")
    );
    rows(&sql, only, pool)
        .await?
        .iter()
        .map(|row| {
            Ok(table_object(
                Some(get(row, "schemaname")?),
                get(row, "indexname")?,
                RelationKind::Index,
                get(row, "indexdef")?,
                get(row, "tablename")?,
            ))
        })
        .collect()
}

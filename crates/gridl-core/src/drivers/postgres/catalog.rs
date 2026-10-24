//! Tables, views and their columns, keys and enum types, read from pg_catalog:
//! information_schema is several times slower on large databases.

use std::collections::{HashMap, HashSet};

use sqlx::postgres::{PgPool, PgRow};
use sqlx::Row;

use super::EnumLabels;
use crate::drivers::common::catalog::push_column;
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::types::{ColumnDefinition, ForeignKey, RelationKind, RelationRef, TableSchema};

/// (schema, table, column) of every primary key column.
type PrimaryKeys = HashSet<(String, String, String)>;

/// A catalog column by name.
pub(super) fn get<'r, T>(row: &'r PgRow, name: &str) -> Result<T, CoreError>
where
    T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(name).map_err(db_err)
}

pub(super) async fn relations(pool: &PgPool) -> Result<Vec<RelationRef>, CoreError> {
    let rows = sqlx::query(
        "SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name",
    )
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(RelationRef {
                schema: Some(get(row, "table_schema")?),
                name: get(row, "table_name")?,
                kind: relation_kind(&get::<String>(row, "table_type")?),
            })
        })
        .collect()
}

fn relation_kind(table_type: &str) -> RelationKind {
    match table_type {
        "VIEW" => RelationKind::View,
        "MATERIALIZED VIEW" => RelationKind::Materialized,
        _ => RelationKind::Table,
    }
}

pub(super) async fn describe(
    pool: &PgPool,
    relation: &RelationRef,
) -> Result<TableSchema, CoreError> {
    let schema = relation
        .schema
        .as_deref()
        .ok_or_else(|| CoreError::InvalidConfig("postgres relations require a schema".into()))?;
    let (keys, enums) =
        tokio::try_join!(primary_keys(pool, Some((schema, &relation.name))), enum_labels(pool))?;
    let rows =
        sqlx::query(&format!("{COLUMNS} AND n.nspname = $1 AND c.relname = $2 ORDER BY a.attnum"))
            .bind(schema)
            .bind(&relation.name)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
    Ok(TableSchema {
        schema: Some(schema.to_owned()),
        name: relation.name.clone(),
        kind: relation.kind,
        columns: rows
            .iter()
            .map(|row| column_from_row(row, &keys, &enums))
            .collect::<Result<_, _>>()?,
        definition: None,
        returns: None,
        parent: None,
    })
}

/// Every table and view with its columns, and the enum labels read on the way.
pub(super) async fn tables(pool: &PgPool) -> Result<(Vec<TableSchema>, EnumLabels), CoreError> {
    let (keys, enums, rows) =
        tokio::try_join!(primary_keys(pool, None), enum_labels(pool), async {
            sqlx::query(&format!("{COLUMNS} ORDER BY n.nspname, c.relname, a.attnum"))
                .fetch_all(pool)
                .await
                .map_err(db_err)
        })?;
    let mut tables = Vec::new();
    for row in &rows {
        let schema: String = get(row, "table_schema")?;
        let name: String = get(row, "table_name")?;
        let kind = relation_kind(&get::<String>(row, "table_type")?);
        let column = column_from_row(row, &keys, &enums)?;
        push_column(&mut tables, Some(&schema), &name, column, || TableSchema {
            schema: Some(schema.clone()),
            name: name.clone(),
            kind,
            columns: Vec::new(),
            definition: None,
            returns: None,
            parent: None,
        });
    }
    Ok((tables, enums))
}

async fn primary_keys(pool: &PgPool, only: Option<(&str, &str)>) -> Result<PrimaryKeys, CoreError> {
    const KEYS: &str =
        "SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
         WHERE con.contype = 'p'
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')";
    let rows = match only {
        Some((schema, table)) => {
            sqlx::query(&format!("{KEYS} AND n.nspname = $1 AND c.relname = $2"))
                .bind(schema)
                .bind(table)
                .fetch_all(pool)
                .await
        }
        None => sqlx::query(KEYS).fetch_all(pool).await,
    }
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok((get(row, "table_schema")?, get(row, "table_name")?, get(row, "column_name")?))
        })
        .collect()
}

/// Every column of the tables, views, materialized views and foreign tables
/// the user can reach, in the shape `column_from_row` reads. Materialized
/// views are missing from information_schema.columns. Callers append filters
/// and an ORDER BY.
const COLUMNS: &str = "SELECT n.nspname AS table_schema, c.relname AS table_name,
        CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN'
            ELSE 'BASE TABLE' END AS table_type,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        un.nspname AS udt_schema, ut.typname AS udt_name,
        CASE WHEN a.attnotnull OR (t.typtype = 'd' AND t.typnotnull) THEN 'NO' ELSE 'YES' END AS is_nullable,
        CASE WHEN a.attgenerated = '' THEN pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) END AS column_default
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     -- information_schema names a domain column by its base type (udt_*).
     JOIN pg_catalog.pg_type ut ON ut.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
     JOIN pg_catalog.pg_namespace un ON un.oid = ut.typnamespace
     LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
       -- The same visibility rule as information_schema.columns.
       AND (pg_catalog.pg_has_role(c.relowner, 'USAGE')
            OR pg_catalog.has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))";

fn column_from_row(
    row: &PgRow,
    keys: &PrimaryKeys,
    enums: &EnumLabels,
) -> Result<ColumnDefinition, CoreError> {
    let schema: String = get(row, "table_schema")?;
    let table: String = get(row, "table_name")?;
    let name: String = get(row, "column_name")?;
    let udt_schema: String = get(row, "udt_schema")?;
    let udt_name: String = get(row, "udt_name")?;
    let options = enums.get(&(udt_schema.clone(), udt_name.clone())).cloned().unwrap_or_default();
    // format_type spells the declared type in full, as psql shows it: character(5), bit(4),
    // numeric(12,2), integer[], billing.status. Edits cast to it, so a length must not be lost.
    let full_type: String = get(row, "data_type")?;
    let data_type =
        if full_type.is_empty() { type_name(&udt_schema, &udt_name) } else { full_type };
    Ok(ColumnDefinition {
        primary_key: keys.contains(&(schema, table, name.clone())),
        name,
        data_type,
        nullable: get::<String>(row, "is_nullable")?.eq_ignore_ascii_case("YES"),
        default_value: get(row, "column_default")?,
        options,
        mode: None,
    })
}

pub(super) async fn enum_labels(pool: &PgPool) -> Result<EnumLabels, CoreError> {
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
    let mut labels = EnumLabels::new();
    for row in &rows {
        let key = (get(row, "type_schema")?, get(row, "type_name")?);
        labels.entry(key).or_default().push(get(row, "label")?);
    }
    Ok(labels)
}

/// A type name as SQL spells it: schema-qualified outside public.
fn type_name(schema: &str, name: &str) -> String {
    if schema.is_empty() || schema == "public" || schema == "pg_catalog" {
        name.to_owned()
    } else {
        format!("{schema}.{name}")
    }
}

/// Gives result columns of an enum type their labels, so the grid offers them.
/// A name shared by enums in several schemas is ambiguous and left alone.
pub(super) fn attach_enum_options(columns: &mut [ColumnDefinition], enums: &EnumLabels) {
    let mut by_name: HashMap<&str, Vec<(&str, &Vec<String>)>> = HashMap::new();
    for ((schema, name), labels) in enums {
        by_name.entry(name.as_str()).or_default().push((schema.as_str(), labels));
    }
    for column in columns.iter_mut().filter(|column| column.options.is_empty()) {
        let Some((name, matches)) =
            by_name.iter().find(|(name, _)| name.eq_ignore_ascii_case(&column.data_type))
        else {
            continue;
        };
        if let [(schema, labels)] = matches.as_slice() {
            column.data_type = type_name(schema, name);
            column.options.clone_from(labels);
        }
    }
}

pub(super) async fn foreign_keys(pool: &PgPool) -> Result<Vec<ForeignKey>, CoreError> {
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
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    rows.iter()
        .map(|row| {
            Ok(ForeignKey {
                name: get(row, "name")?,
                schema: Some(get(row, "schema_name")?),
                table: get(row, "table_name")?,
                columns: get(row, "columns")?,
                ref_schema: Some(get(row, "ref_schema")?),
                ref_table: get(row, "ref_table")?,
                ref_columns: get(row, "ref_columns")?,
                on_update: action(&get::<String>(row, "on_update")?),
                on_delete: action(&get::<String>(row, "on_delete")?),
            })
        })
        .collect()
}

/// Spells out the one-letter action codes of `pg_constraint`.
fn action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_owned()
}

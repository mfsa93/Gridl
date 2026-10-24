use sqlx::database::HasStatementCache;
use sqlx::query::Query;
use sqlx::{Arguments, Database, Encode, IntoArguments, Type};

use crate::error::CoreError;
use crate::value::SqlValue;

/// `sql` with `params` bound in order, for any sqlx engine. Statements are not
/// cached: editor SQL rarely repeats and the cache would only grow.
pub(crate) fn bound<'q, DB>(
    sql: &'q str,
    params: &'q [SqlValue],
) -> Result<Query<'q, DB, <DB as Database>::Arguments<'q>>, CoreError>
where
    DB: Database + HasStatementCache,
    <DB as Database>::Arguments<'q>: IntoArguments<'q, DB>,
    Option<i64>: Encode<'q, DB> + Type<DB>,
    bool: Encode<'q, DB> + Type<DB>,
    i64: Encode<'q, DB> + Type<DB>,
    f64: Encode<'q, DB> + Type<DB>,
    &'q str: Encode<'q, DB> + Type<DB>,
    &'q [u8]: Encode<'q, DB> + Type<DB>,
{
    let mut args = <DB as Database>::Arguments::<'q>::default();
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

//! One adapter per engine behind [`DatabaseDriver`], plus what they share in
//! [`common`]. Each engine is a folder: `mod.rs` implements the trait and
//! delegates to `connect`, `catalog` and `query`.

pub(crate) mod common;
mod mysql;
mod postgres;
mod sqlite;
mod sqlserver;

pub use mysql::MysqlDriver;
pub use postgres::PostgresDriver;
pub use sqlite::SqliteDriver;
pub use sqlserver::SqlserverDriver;

use crate::DatabaseDriver;

/// One driver of every engine built into the app. A new engine adds its driver here.
pub fn builtin_drivers() -> Vec<Box<dyn DatabaseDriver>> {
    vec![
        Box::new(PostgresDriver::new()),
        Box::new(MysqlDriver::new()),
        Box::new(SqliteDriver::new()),
        Box::new(SqlserverDriver::new()),
    ]
}

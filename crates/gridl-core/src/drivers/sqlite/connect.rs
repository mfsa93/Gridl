use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::tr;
use crate::types::{ConnectionConfig, DatabaseEngine};

pub(super) async fn open_pool(
    config: &ConnectionConfig,
    max_connections: u32,
) -> Result<SqlitePool, CoreError> {
    config.validate()?;
    if config.engine != DatabaseEngine::Sqlite {
        return Err(CoreError::InvalidConfig(
            "sqlite driver received a non-sqlite connection".into(),
        ));
    }
    let path = resolve_path(config)?;
    let mut options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(config.create_if_missing)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    if config.read_only {
        options = options.read_only(true);
    }
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(15))
        .connect_with(options)
        .await
        .map_err(db_err)
}

/// The absolute path of the database file. A file that does not exist yet is
/// only accepted when the connection may create it, in a folder that exists.
fn resolve_path(config: &ConnectionConfig) -> Result<PathBuf, CoreError> {
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

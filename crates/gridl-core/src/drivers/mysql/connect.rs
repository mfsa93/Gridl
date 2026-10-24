use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::Executor;

use super::catalog::{opt_text, text};
use crate::drivers::common::db_err;
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::{ConnectionConfig, DatabaseEngine, TlsMode};

pub(super) async fn open_pool(
    config: &ConnectionConfig,
    password: Option<&SecretString>,
    endpoint: Option<&(String, u16)>,
    max_connections: u32,
) -> Result<MySqlPool, CoreError> {
    let options = options(config, password, endpoint)?;
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

pub(super) async fn server_identity(pool: &MySqlPool) -> Result<(String, String), CoreError> {
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

pub(super) fn is_mariadb(version: &str) -> bool {
    version.to_ascii_lowercase().contains("mariadb")
}

fn options(
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
        .ssl_mode(ssl_mode(config.tls.mode))
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

fn ssl_mode(mode: TlsMode) -> MySqlSslMode {
    match mode {
        TlsMode::Disable => MySqlSslMode::Disabled,
        TlsMode::Prefer => MySqlSslMode::Preferred,
        TlsMode::Require => MySqlSslMode::Required,
        TlsMode::VerifyCa => MySqlSslMode::VerifyCa,
        TlsMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

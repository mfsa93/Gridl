use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};

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
) -> Result<PgPool, CoreError> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(15))
        .connect_with(options(config, password, endpoint)?)
        .await
        .map_err(db_err)
}

fn options(
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
    // `endpoint` is the local end of an SSH tunnel, when there is one.
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
        .ssl_mode(ssl_mode(config.tls.mode));
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

fn ssl_mode(mode: TlsMode) -> PgSslMode {
    match mode {
        TlsMode::Disable => PgSslMode::Disable,
        TlsMode::Prefer => PgSslMode::Prefer,
        TlsMode::Require => PgSslMode::Require,
        TlsMode::VerifyCa => PgSslMode::VerifyCa,
        TlsMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

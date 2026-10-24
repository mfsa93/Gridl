use std::time::Duration;

use tiberius::{AuthMethod, Client, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use super::decode::opt_text;
use super::pool::first_result;
use super::MsClient;
use crate::error::CoreError;
use crate::secret::SecretString;
use crate::tr;
use crate::types::{ConnectionConfig, DatabaseEngine, TlsMode};

/// Session options every other SQL Server client sets at login. Without
/// QUOTED_IDENTIFIER, "name" would be a string instead of a name.
const SESSION_OPTIONS: &str = "SET ANSI_NULLS, ANSI_PADDING, ANSI_WARNINGS, ARITHABORT, \
     CONCAT_NULL_YIELDS_NULL, QUOTED_IDENTIFIER ON; SET NUMERIC_ROUNDABORT OFF; \
     SET TEXTSIZE 2147483647";

pub(super) fn config(
    config: &ConnectionConfig,
    password: Option<&SecretString>,
    endpoint: Option<&(String, u16)>,
) -> Result<Config, CoreError> {
    config.validate()?;
    if config.engine != DatabaseEngine::Sqlserver {
        return Err(CoreError::InvalidConfig(
            "sqlserver driver received another engine's connection".into(),
        ));
    }
    let username = config.username.as_deref().ok_or_else(|| {
        CoreError::InvalidConfig(tr!(
            "SQL Server needs a username",
            "SQL Server necesita un usuario"
        ))
    })?;
    let (host, port) = match endpoint {
        Some((host, port)) => (host.as_str(), *port),
        None => (config.host.as_deref().unwrap_or("localhost"), config.port.unwrap_or(1433)),
    };
    let mut ms = Config::new();
    ms.host(host);
    ms.port(port);
    ms.database(&config.database);
    ms.application_name("Gridl");
    ms.authentication(AuthMethod::sql_server(
        username,
        password.map(SecretString::expose).unwrap_or_default(),
    ));
    match config.tls.mode {
        // Only the login packet is encrypted, which every server accepts.
        TlsMode::Disable => ms.encryption(EncryptionLevel::Off),
        // Servers usually present a self-signed certificate; the verify modes check it.
        TlsMode::Prefer => {
            ms.encryption(EncryptionLevel::On);
            ms.trust_cert();
        }
        TlsMode::Require => {
            ms.encryption(EncryptionLevel::Required);
            ms.trust_cert();
        }
        TlsMode::VerifyCa | TlsMode::VerifyFull => {
            ms.encryption(EncryptionLevel::Required);
            if let Some(path) = &config.tls.root_cert {
                ms.trust_cert_ca(path);
            }
        }
    }
    if let (Some(cert), Some(key)) = (&config.tls.client_cert, &config.tls.client_key) {
        ms.client_certificate(cert, key);
    }
    Ok(ms)
}

/// Connects, following one redirect (Azure SQL gateways send clients on to
/// the database's node), and sets the usual session options.
pub(super) async fn open_client(mut config: Config) -> Result<MsClient, CoreError> {
    for _ in 0..2 {
        let tcp =
            tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(config.get_addr()))
                .await
                .map_err(|_| {
                    CoreError::Database(tr!("connection timed out", "la conexión tardó demasiado"))
                })??;
        tcp.set_nodelay(true)?;
        match Client::connect(config.clone(), tcp.compat_write()).await {
            Ok(mut client) => {
                simple(&mut client, SESSION_OPTIONS).await?;
                return Ok(client);
            }
            Err(tiberius::error::Error::Routing { host, port }) => {
                config.host(host);
                config.port(port);
            }
            Err(err) => return Err(server_err(err)),
        }
    }
    Err(CoreError::Database(tr!(
        "the server redirected the connection more than once",
        "el servidor redirigió la conexión más de una vez"
    )))
}

pub(super) async fn simple(client: &mut MsClient, sql: &str) -> Result<(), CoreError> {
    client.simple_query(sql).await.map_err(server_err)?.into_results().await.map_err(server_err)?;
    Ok(())
}

pub(super) fn server_err(err: tiberius::error::Error) -> CoreError {
    match err {
        tiberius::error::Error::Io { kind, message } => {
            CoreError::Io(std::io::Error::new(kind, message))
        }
        other => CoreError::Database(error_text(&other)),
    }
}

/// The server's own message, without tiberius' "Token error:" wrapping.
pub(super) fn error_text(err: &tiberius::error::Error) -> String {
    match err {
        tiberius::error::Error::Server(token) => token.message().to_owned(),
        other => other.to_string(),
    }
}

/// "SQL Server 16.0.4135.4", or "Azure SQL …" for the cloud edition.
pub(super) async fn server_version(client: &mut MsClient) -> Result<String, CoreError> {
    let rows = first_result(
        client,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)),
                CAST(SERVERPROPERTY('Edition') AS nvarchar(128))",
        &[],
    )
    .await?;
    let row = rows.first().ok_or_else(|| CoreError::Database("no version".into()))?;
    let version = opt_text(row, 0).unwrap_or_default();
    Ok(match opt_text(row, 1) {
        Some(edition) if edition.contains("Azure") => format!("Azure SQL {version}"),
        _ => format!("SQL Server {version}"),
    })
}

//! Backups with `mysqldump` and restores with `mysql`, the MySQL clients.

use std::path::Path;

use crate::driver::ToolAccess;
use crate::drivers::common::tools::{address, run, Tool};
use crate::error::CoreError;
use crate::types::TlsMode;

const MYSQLDUMP: Tool = Tool { name: "mysqldump", install: "brew install mysql-client" };
const MYSQL: Tool = Tool { name: "mysql", install: "brew install mysql-client" };

/// A consistent snapshot with routines and triggers. Tablespaces are left out:
/// dumping them needs the PROCESS privilege, which most users lack.
pub(super) async fn dump(access: &ToolAccess<'_>, out: &Path) -> Result<(), CoreError> {
    let mut args = vec![
        "--single-transaction".to_owned(),
        "--routines".to_owned(),
        "--triggers".to_owned(),
        "--no-tablespaces".to_owned(),
        format!("--result-file={}", out.display()),
    ];
    args.extend(connection_args(access));
    run(MYSQLDUMP, &args, env(access), None).await
}

/// The client reads the dump on its standard input.
pub(super) async fn load(access: &ToolAccess<'_>, input: &Path) -> Result<(), CoreError> {
    run(MYSQL, &connection_args(access), env(access), Some(input)).await
}

fn connection_args(access: &ToolAccess<'_>) -> Vec<String> {
    let (host, port) = address(access);
    let config = access.config;
    let mut args =
        vec![format!("--host={host}"), format!("--port={port}"), "--protocol=TCP".to_owned()];
    if let Some(user) = &config.username {
        args.push(format!("--user={user}"));
    }
    let mode = match config.tls.mode {
        TlsMode::Prefer => None,
        TlsMode::Disable => Some("DISABLED"),
        TlsMode::Require => Some("REQUIRED"),
        TlsMode::VerifyCa => Some("VERIFY_CA"),
        TlsMode::VerifyFull => Some("VERIFY_IDENTITY"),
    };
    if let Some(mode) = mode {
        args.push(format!("--ssl-mode={mode}"));
    }
    let files = [
        ("--ssl-ca", &config.tls.root_cert),
        ("--ssl-cert", &config.tls.client_cert),
        ("--ssl-key", &config.tls.client_key),
    ];
    for (flag, path) in files {
        if let Some(path) = path {
            args.push(format!("{flag}={path}"));
        }
    }
    args.push(config.database.clone());
    args
}

/// The password, which the clients read from `MYSQL_PWD`.
fn env(access: &ToolAccess<'_>) -> Vec<(String, String)> {
    access
        .password
        .map(|password| vec![("MYSQL_PWD".into(), password.expose().to_owned())])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::common::tools::tests::config;
    use crate::secret::SecretString;
    use crate::types::DatabaseEngine;

    #[test]
    fn tools_reach_the_tunnel_and_keep_the_password_off_the_command_line() {
        let config = config(DatabaseEngine::Mysql);
        let secret = SecretString::new("s3cret".into());
        let access = ToolAccess {
            config: &config,
            endpoint: Some(("127.0.0.1".into(), 40123)),
            password: Some(&secret),
        };
        let args = connection_args(&access);
        assert_eq!(args[..3], ["--host=127.0.0.1", "--port=40123", "--protocol=TCP"]);
        assert_eq!(args.last().map(String::as_str), Some("app"));
        assert!(!args.iter().any(|arg| arg.contains("s3cret")));
        assert_eq!(env(&access), vec![("MYSQL_PWD".to_owned(), "s3cret".to_owned())]);
    }
}

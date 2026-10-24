//! Backups with `pg_dump` and restores with `psql`, the PostgreSQL clients.

use std::path::Path;

use crate::driver::ToolAccess;
use crate::drivers::common::tools::{address, run, Tool};
use crate::error::CoreError;
use crate::types::TlsMode;

const PG_DUMP: Tool = Tool { name: "pg_dump", install: "brew install libpq" };
const PSQL: Tool = Tool { name: "psql", install: "brew install libpq" };

/// Plain SQL that drops each object before creating it, so restoring over the
/// same database works, without owners or grants that may not exist there.
pub(super) async fn dump(access: &ToolAccess<'_>, out: &Path) -> Result<(), CoreError> {
    let mut args = vec![
        "--no-owner".to_owned(),
        "--no-privileges".to_owned(),
        "--clean".to_owned(),
        "--if-exists".to_owned(),
        format!("--file={}", out.display()),
    ];
    args.extend(connection_args(access));
    run(PG_DUMP, &args, env(access), None).await
}

/// One transaction that stops at the first error, so a failed restore changes nothing.
pub(super) async fn load(access: &ToolAccess<'_>, input: &Path) -> Result<(), CoreError> {
    let mut args = vec![
        "--no-psqlrc".to_owned(),
        "--quiet".to_owned(),
        "-v".to_owned(),
        "ON_ERROR_STOP=1".to_owned(),
        "--single-transaction".to_owned(),
        format!("--file={}", input.display()),
    ];
    args.extend(connection_args(access));
    run(PSQL, &args, env(access), None).await
}

fn connection_args(access: &ToolAccess<'_>) -> Vec<String> {
    let (host, port) = address(access);
    let mut args = vec![format!("--host={host}"), format!("--port={port}")];
    if let Some(user) = &access.config.username {
        args.push(format!("--username={user}"));
    }
    args.push("--no-password".into());
    args.push(format!("--dbname={}", access.config.database));
    args
}

/// TLS settings and the password, which libpq reads from the environment.
fn env(access: &ToolAccess<'_>) -> Vec<(String, String)> {
    let tls = &access.config.tls;
    let mode = match tls.mode {
        TlsMode::Disable => "disable",
        TlsMode::Prefer => "prefer",
        TlsMode::Require => "require",
        TlsMode::VerifyCa => "verify-ca",
        TlsMode::VerifyFull => "verify-full",
    };
    let mut env = vec![
        ("PGSSLMODE".to_owned(), mode.to_owned()),
        ("PGCONNECT_TIMEOUT".to_owned(), "15".to_owned()),
    ];
    let files = [
        ("PGSSLROOTCERT", &tls.root_cert),
        ("PGSSLCERT", &tls.client_cert),
        ("PGSSLKEY", &tls.client_key),
    ];
    for (name, path) in files {
        if let Some(path) = path {
            env.push((name.to_owned(), path.clone()));
        }
    }
    if let Some(password) = access.password {
        env.push(("PGPASSWORD".into(), password.expose().to_owned()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::common::tools::tests::config;
    use crate::secret::SecretString;
    use crate::types::DatabaseEngine;

    #[test]
    fn the_password_goes_through_the_environment_only() {
        let config = config(DatabaseEngine::Postgres);
        let secret = SecretString::new("s3cret".into());
        let access = ToolAccess { config: &config, endpoint: None, password: Some(&secret) };
        let args = connection_args(&access);
        assert!(args.contains(&"--host=db.internal".to_owned()));
        assert!(args.contains(&"--port=5432".to_owned()));
        assert!(args.contains(&"--dbname=app".to_owned()));
        assert!(!args.iter().any(|arg| arg.contains("s3cret")));
        let env = env(&access);
        assert!(env.contains(&("PGPASSWORD".into(), "s3cret".into())));
        assert!(env.contains(&("PGSSLMODE".into(), "prefer".into())));
    }
}

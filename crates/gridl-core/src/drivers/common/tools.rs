//! The engines' own command line tools (`pg_dump`, `mysql`…): finding them,
//! where they connect, and running them. Each driver says which tool and
//! which arguments; passwords go through the environment, never the command line.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::driver::ToolAccess;
use crate::error::CoreError;
use crate::tr;

/// Folders searched after `PATH`. An app opened from Finder gets a short `PATH`.
const TOOL_DIRS: [&str; 5] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/usr/local/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
];

/// A command line tool and how to install it when it is missing.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Tool {
    pub name: &'static str,
    pub install: &'static str,
}

/// Host and port the tool connects to: the SSH tunnel's local end when there
/// is one, else the saved host and port (or the engine's default port).
pub(crate) fn address(access: &ToolAccess<'_>) -> (String, u16) {
    if let Some((host, port)) = &access.endpoint {
        return (host.clone(), *port);
    }
    access.config.server()
}

/// Runs `tool` and returns its error output when it fails. `stdin` is a file
/// the tool reads, for clients that take SQL on standard input.
pub(crate) async fn run(
    tool: Tool,
    args: &[String],
    env: Vec<(String, String)>,
    stdin: Option<&Path>,
) -> Result<(), CoreError> {
    let name = tool.name;
    let binary = find(name).ok_or_else(|| {
        let hint = tool.install;
        CoreError::Transfer(tr!(
            "Couldn't find {name}. Install it with: {hint}",
            "No encontré {name}. Instálalo con: {hint}"
        ))
    })?;
    let input = match stdin {
        Some(path) => Stdio::from(std::fs::File::open(path).map_err(|err| {
            CoreError::Transfer(tr!(
                "Couldn't open the backup: {err}",
                "No se pudo abrir el respaldo: {err}"
            ))
        })?),
        None => Stdio::null(),
    };
    let output = tokio::process::Command::new(&binary)
        .args(args)
        .envs(env)
        .stdin(input)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|err| {
            CoreError::Transfer(tr!(
                "Couldn't run {name}: {err}",
                "No se pudo ejecutar {name}: {err}"
            ))
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        let status = output.status;
        return Err(CoreError::Transfer(tr!(
            "{name} ended with {status}",
            "{name} terminó con {status}"
        )));
    }
    Err(CoreError::Transfer(stderr))
}

/// Finds `name` on `PATH` or in [`TOOL_DIRS`].
fn find(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(TOOL_DIRS.iter().map(PathBuf::from))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::types::{ConnectionConfig, DatabaseEngine};

    /// A server connection as backups see it, for the engines' tests.
    pub(crate) fn config(engine: DatabaseEngine) -> ConnectionConfig {
        ConnectionConfig {
            id: "c".into(),
            name: "c".into(),
            engine,
            database: "app".into(),
            host: Some("db.internal".into()),
            port: None,
            username: Some("ana".into()),
            credential_account: None,
            group: None,
            read_only: false,
            create_if_missing: false,
            tls: crate::types::TlsSettings::default(),
            ssh: crate::types::SshSettings::default(),
            safety: crate::guard::SafetySettings::default(),
        }
    }

    #[test]
    fn tools_reach_the_tunnel_or_the_saved_server() {
        let config = config(DatabaseEngine::Postgres);
        let direct = ToolAccess { config: &config, endpoint: None, password: None };
        assert_eq!(address(&direct), ("db.internal".to_owned(), 5432));
        let tunneled = ToolAccess {
            config: &config,
            endpoint: Some(("127.0.0.1".into(), 40123)),
            password: None,
        };
        assert_eq!(address(&tunneled), ("127.0.0.1".to_owned(), 40123));
    }

    #[tokio::test]
    async fn missing_tools_say_how_to_install_them() {
        // The language is process-wide and other tests run alongside, so the
        // message is checked for what it names, not for its wording.
        let tool = Tool { name: "gridl-no-such-tool", install: "brew install gridl-tool" };
        let err = run(tool, &[], Vec::new(), None).await.expect_err("missing").to_string();
        assert!(err.contains("gridl-no-such-tool"), "{err}");
        assert!(err.ends_with("brew install gridl-tool"), "{err}");
    }
}

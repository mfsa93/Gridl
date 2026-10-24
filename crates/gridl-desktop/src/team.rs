//! The team space: a `gridl-team.json` file in a folder the user picks (a git
//! repository, iCloud, Dropbox…). It holds shared connections without any
//! secret, and the saved queries of those connections. No server is involved;
//! whatever syncs the folder shares the file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use gridl_core::{ConnectionConfig, CoreError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::fail;

const TEAM_FILE: &str = "gridl-team.json";

/// A saved query kept in the team file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamFile {
    #[serde(default = "version")]
    version: u32,
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
    /// Saved queries by connection id.
    #[serde(default)]
    queries: BTreeMap<String, Vec<TeamQuery>>,
}

fn version() -> u32 {
    1
}

/// What the app shows of the team space.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamState {
    /// The linked folder, or none.
    pub folder: Option<String>,
    pub connections: Vec<ConnectionConfig>,
    pub queries: BTreeMap<String, Vec<TeamQuery>>,
    /// Last change of the team file in milliseconds, to notice edits from others.
    pub modified: Option<u64>,
    /// Set when the file exists but cannot be read.
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TeamSettings {
    folder: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, CoreError> {
    let directory =
        app.path().app_data_dir().map_err(|err| CoreError::Internal(err.to_string()))?;
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("team.json"))
}

fn linked_folder(app: &AppHandle) -> Result<Option<PathBuf>, CoreError> {
    let path = settings_path(app)?;
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    let settings: TeamSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(settings.folder.map(PathBuf::from))
}

fn read_file(folder: &Path) -> Result<TeamFile, CoreError> {
    match std::fs::read(folder.join(TEAM_FILE)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|err| CoreError::Profile(err.to_string()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(TeamFile { version: 1, ..TeamFile::default() })
        }
        Err(err) => Err(err.into()),
    }
}

/// Writes the team file whole: a temporary file renamed over the old one, so
/// a sync tool or a teammate never reads it half written.
fn write_file(folder: &Path, file: &TeamFile) -> Result<(), CoreError> {
    let json =
        serde_json::to_vec_pretty(file).map_err(|err| CoreError::Profile(err.to_string()))?;
    let target = folder.join(TEAM_FILE);
    let temporary = folder.join(format!(".{TEAM_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, json)?;
    std::fs::rename(&temporary, &target)?;
    Ok(())
}

fn modified(folder: &Path) -> Option<u64> {
    let time = std::fs::metadata(folder.join(TEAM_FILE)).ok()?.modified().ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// A connection as the team sees it: nothing that points into one person's keychain.
fn shareable(mut config: ConnectionConfig) -> ConnectionConfig {
    config.credential_account = None;
    config.ssh.credential_account = None;
    config
}

fn state(app: &AppHandle) -> Result<TeamState, CoreError> {
    let Some(folder) = linked_folder(app)? else { return Ok(TeamState::default()) };
    let display = folder.display().to_string();
    match read_file(&folder) {
        Ok(file) => Ok(TeamState {
            folder: Some(display),
            connections: file.connections,
            queries: file.queries,
            modified: modified(&folder),
            error: None,
        }),
        Err(err) => Ok(TeamState {
            folder: Some(display),
            error: Some(err.to_string()),
            ..TeamState::default()
        }),
    }
}

fn change(app: &AppHandle, edit: impl FnOnce(&mut TeamFile)) -> Result<TeamState, CoreError> {
    let folder = linked_folder(app)?
        .ok_or_else(|| CoreError::InvalidConfig("no team folder is linked".into()))?;
    let mut file = read_file(&folder)?;
    edit(&mut file);
    write_file(&folder, &file)?;
    state(app)
}

#[tauri::command]
pub async fn team_state(app: AppHandle) -> Result<TeamState, String> {
    state(&app).map_err(fail)
}

/// Links the team folder, or unlinks it with `None`. The file is created on the first share.
#[tauri::command]
pub async fn team_link(app: AppHandle, folder: Option<String>) -> Result<TeamState, String> {
    if let Some(folder) = &folder {
        if !Path::new(folder).is_dir() {
            return Err(fail(CoreError::InvalidConfig(format!("{folder} is not a folder"))));
        }
    }
    let path = settings_path(&app).map_err(fail)?;
    let json =
        serde_json::to_vec_pretty(&TeamSettings { folder }).map_err(|err| err.to_string())?;
    std::fs::write(path, json).map_err(|err| err.to_string())?;
    state(&app).map_err(fail)
}

/// Adds or updates a connection in the team file.
#[tauri::command]
pub async fn team_share(app: AppHandle, config: ConnectionConfig) -> Result<TeamState, String> {
    let config = shareable(config);
    change(&app, move |file| match file.connections.iter_mut().find(|item| item.id == config.id) {
        Some(existing) => *existing = config,
        None => file.connections.push(config),
    })
    .map_err(fail)
}

/// Takes a connection out of the team file, with its saved queries.
#[tauri::command]
pub async fn team_unshare(app: AppHandle, connection_id: String) -> Result<TeamState, String> {
    change(&app, move |file| {
        file.connections.retain(|item| item.id != connection_id);
        file.queries.remove(&connection_id);
    })
    .map_err(fail)
}

/// Replaces the saved queries of a team connection.
#[tauri::command]
pub async fn team_save_queries(
    app: AppHandle,
    connection_id: String,
    queries: Vec<TeamQuery>,
) -> Result<TeamState, String> {
    change(&app, move |file| {
        if queries.is_empty() {
            file.queries.remove(&connection_id);
        } else {
            file.queries.insert(connection_id, queries);
        }
    })
    .map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_file_round_trips_without_secrets() {
        let folder = std::env::temp_dir().join(format!("gridl-team-{}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("folder");
        let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "Prod", "engine": "postgres", "database": "app",
            "host": "db", "port": 5432, "username": "app", "credentialAccount": "keychain-1",
            "group": null, "readOnly": true, "createIfMissing": false
        }))
        .expect("config");
        config.ssh.credential_account = Some("ssh-keychain".into());
        let mut file = read_file(&folder).expect("empty");
        assert!(file.connections.is_empty());
        file.connections.push(shareable(config));
        file.queries.insert(
            "c1".into(),
            vec![TeamQuery { id: "q".into(), name: "Top".into(), sql: "select 1".into(), at: 1 }],
        );
        write_file(&folder, &file).expect("write");
        let back = read_file(&folder).expect("read");
        assert_eq!(back.connections[0].credential_account, None);
        assert_eq!(back.connections[0].ssh.credential_account, None);
        assert!(back.connections[0].read_only);
        assert_eq!(back.queries["c1"][0].sql, "select 1");
        let text = std::fs::read_to_string(folder.join(TEAM_FILE)).expect("text");
        assert!(!text.contains("keychain"), "{text}");
        let _ = std::fs::remove_dir_all(&folder);
    }
}

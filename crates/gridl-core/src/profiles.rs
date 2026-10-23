use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::types::{validate_group_name, ConnectionConfig};

/// Saved connections and the folders that group them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCatalog {
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<ConnectionConfig>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfileFile {
    #[serde(default)]
    groups: Vec<String>,
    profiles: Vec<ConnectionConfig>,
}

/// Read saved connections. A missing file is an empty catalog, not an error.
///
/// # Errors
///
/// Returns an error when the file cannot be read or contains an invalid profile.
pub fn load_catalog(path: &Path) -> Result<ConnectionCatalog, CoreError> {
    if !path.exists() {
        return Ok(ConnectionCatalog::default());
    }
    let bytes = fs::read(path)?;
    let file: ProfileFile =
        serde_json::from_slice(&bytes).map_err(|err| CoreError::Profile(err.to_string()))?;
    let catalog = ConnectionCatalog { groups: file.groups, profiles: file.profiles };
    validate_catalog(&catalog)?;
    Ok(catalog)
}

pub fn load_profiles(path: &Path) -> Result<Vec<ConnectionConfig>, CoreError> {
    Ok(load_catalog(path)?.profiles)
}

/// Insert or replace one connection and remember its group.
pub fn upsert_profile(
    path: &Path,
    config: ConnectionConfig,
) -> Result<ConnectionCatalog, CoreError> {
    let config = config.prepare()?;
    let mut catalog = load_catalog(path)?;
    if let Some(group) = &config.group {
        remember_group(&mut catalog, group)?;
    }
    if let Some(existing) = catalog.profiles.iter_mut().find(|profile| profile.id == config.id) {
        *existing = config;
    } else {
        catalog.profiles.push(config);
    }
    store_catalog(path, &catalog)?;
    Ok(catalog)
}

pub fn add_group(path: &Path, name: &str) -> Result<ConnectionCatalog, CoreError> {
    let mut catalog = load_catalog(path)?;
    remember_group(&mut catalog, name.trim())?;
    store_catalog(path, &catalog)?;
    Ok(catalog)
}

pub fn remove_group(path: &Path, name: &str) -> Result<ConnectionCatalog, CoreError> {
    let mut catalog = load_catalog(path)?;
    catalog.groups.retain(|group| group != name);
    for profile in &mut catalog.profiles {
        if profile.group.as_deref() == Some(name) {
            profile.group = None;
        }
    }
    store_catalog(path, &catalog)?;
    Ok(catalog)
}

fn remember_group(catalog: &mut ConnectionCatalog, name: &str) -> Result<(), CoreError> {
    validate_group_name(name)?;
    if !catalog.groups.iter().any(|group| group == name) {
        catalog.groups.push(name.to_owned());
    }
    Ok(())
}

fn validate_catalog(catalog: &ConnectionCatalog) -> Result<(), CoreError> {
    for group in &catalog.groups {
        validate_group_name(group)?;
    }
    for profile in &catalog.profiles {
        profile.validate()?;
    }
    Ok(())
}

/// Atomically replace the profile catalog. Secrets must already be absent.
///
/// # Errors
///
/// Returns an error when the parent directory is missing or the rename fails.
pub fn store_catalog(path: &Path, catalog: &ConnectionCatalog) -> Result<(), CoreError> {
    validate_catalog(catalog)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temporary = temporary_path(path);
    write_private(
        &temporary,
        &ProfileFile { groups: catalog.groups.clone(), profiles: catalog.profiles.clone() },
    )?;
    fs::rename(&temporary, path)?;
    Ok(())
}

pub fn store_profiles(path: &Path, profiles: &[ConnectionConfig]) -> Result<(), CoreError> {
    let mut catalog = load_catalog(path)?;
    catalog.profiles = profiles.to_vec();
    store_catalog(path, &catalog)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_else(|| "connections.json".into());
    name.push(".tmp");
    path.with_file_name(name)
}

fn write_private(path: &Path, file: &ProfileFile) -> Result<(), CoreError> {
    let json =
        serde_json::to_vec_pretty(file).map_err(|err| CoreError::Profile(err.to_string()))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(path)?;
    handle.write_all(&json)?;
    handle.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{add_group, load_catalog, load_profiles, store_profiles};
    use crate::types::{ConnectionConfig, DatabaseEngine};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample() -> ConnectionConfig {
        ConnectionConfig {
            id: "local-main".into(),
            name: "Local".into(),
            engine: DatabaseEngine::Sqlite,
            database: "/tmp/gridl.sqlite".into(),
            host: None,
            port: None,
            username: None,
            credential_account: Some("connection:local-main".into()),
            group: Some("Local".into()),
            read_only: false,
            create_if_missing: false,
            tls: crate::types::TlsSettings::default(),
            ssh: crate::types::SshSettings::default(),
            safety: crate::guard::SafetySettings::default(),
        }
    }

    #[test]
    fn profiles_roundtrip_without_a_password_field() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let path = std::env::temp_dir().join(format!("gridl-profiles-{nanos}.json"));
        store_profiles(&path, &[sample()]).expect("store");
        let raw = std::fs::read_to_string(&path).expect("read raw");
        assert!(!raw.contains("\"password\":"));
        assert!(!raw.contains("secret"));
        assert!(raw.contains("credentialAccount"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let loaded = load_profiles(&path).expect("load");
        assert_eq!(loaded, vec![sample()]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn empty_groups_survive_a_profile_rewrite() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let path = std::env::temp_dir().join(format!("gridl-groups-{nanos}.json"));
        add_group(&path, "Trabajo").expect("group");
        store_profiles(&path, &[sample()]).expect("store");
        let catalog = load_catalog(&path).expect("load");
        assert_eq!(catalog.groups, vec!["Trabajo".to_owned()]);
        assert_eq!(catalog.profiles[0].group.as_deref(), Some("Local"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_profile_without_security_fields_still_loads() {
        let raw = r#"{
            "id": "local-main",
            "name": "Local",
            "engine": "sqlite",
            "database": "/tmp/gridl.sqlite",
            "host": null,
            "port": null,
            "username": null,
            "credentialAccount": "connection:local-main",
            "group": "Local",
            "readOnly": false,
            "createIfMissing": false
        }"#;
        let loaded: ConnectionConfig = serde_json::from_str(raw).expect("legacy profile");
        assert_eq!(loaded, sample());
        assert!(!raw.contains("password"));
    }
}

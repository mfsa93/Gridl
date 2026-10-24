use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use gridl_core::{
    ConnectionConfig, ConnectionId, CoreError, DatabaseDriver, DatabaseEngine, SafetySettings,
};

use crate::tunnel::SshTunnel;
use crate::vault::KeyringVault;

pub const KEYRING_SERVICE: &str = "app.gridl.desktop";

/// One open session: the config it was opened with and, when it goes through
/// an SSH tunnel, the local end of that tunnel, so external tools such as
/// `pg_dump` can reach the same server.
#[derive(Debug, Clone)]
pub struct Session {
    pub config: ConnectionConfig,
    pub endpoint: Option<(String, u16)>,
}

/// Process-wide sessions, cancellation flags, and the credential adapter.
pub struct AppState {
    /// One driver per engine, from `gridl_core::builtin_drivers`.
    drivers: Vec<Box<dyn DatabaseDriver>>,
    sessions: RwLock<HashMap<String, Session>>,
    tunnels: Mutex<HashMap<String, SshTunnel>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Connection id to the label of the window that owns it.
    owners: Mutex<HashMap<String, String>>,
    pub profile_lock: Arc<Mutex<()>>,
    /// Labels of windows holding edits that closing them would lose.
    unsaved: Mutex<BTreeSet<String>>,
    pub vault: KeyringVault,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            drivers: gridl_core::builtin_drivers(),
            sessions: RwLock::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            profile_lock: Arc::new(Mutex::new(())),
            unsaved: Mutex::new(BTreeSet::new()),
            vault: KeyringVault::new(KEYRING_SERVICE),
        }
    }

    pub fn driver(&self, engine: DatabaseEngine) -> &dyn DatabaseDriver {
        self.drivers
            .iter()
            .find(|driver| driver.engine() == engine)
            .map(Box::as_ref)
            .expect("every engine has a driver in gridl_core::builtin_drivers")
    }

    pub fn track(
        &self,
        id: &ConnectionId,
        config: ConnectionConfig,
        endpoint: Option<(String, u16)>,
    ) -> Result<(), CoreError> {
        let mut sessions = self.sessions.write().map_err(|_| CoreError::LockPoisoned)?;
        sessions.insert(id.as_str().to_owned(), Session { config, endpoint });
        Ok(())
    }

    /// The config and tunnel endpoint of an open session.
    pub fn session(&self, id: &str) -> Result<Session, CoreError> {
        let sessions = self.sessions.read().map_err(|_| CoreError::LockPoisoned)?;
        sessions.get(id).cloned().ok_or_else(|| CoreError::NotConnected(id.to_owned()))
    }

    pub fn untrack(&self, id: &ConnectionId) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(id.as_str());
        }
    }

    pub fn insert_tunnel(&self, id: &str, tunnel: SshTunnel) {
        if let Ok(mut tunnels) = self.tunnels.lock() {
            tunnels.insert(id.to_owned(), tunnel);
        }
    }

    pub fn drop_tunnel(&self, id: &str) {
        if let Ok(mut tunnels) = self.tunnels.lock() {
            tunnels.remove(id);
        }
    }

    pub fn engine(&self, id: &str) -> Result<DatabaseEngine, CoreError> {
        let sessions = self.sessions.read().map_err(|_| CoreError::LockPoisoned)?;
        sessions
            .get(id)
            .map(|session| session.config.engine)
            .ok_or_else(|| CoreError::NotConnected(id.to_owned()))
    }

    /// The safety policy the session was opened with.
    pub fn safety(&self, id: &str) -> Result<SafetySettings, CoreError> {
        let sessions = self.sessions.read().map_err(|_| CoreError::LockPoisoned)?;
        sessions
            .get(id)
            .map(|session| session.config.safety.clone())
            .ok_or_else(|| CoreError::NotConnected(id.to_owned()))
    }

    /// Returns false when `query_id` is already running.
    pub fn register_cancel(
        &self,
        query_id: &str,
        flag: Arc<AtomicBool>,
    ) -> Result<bool, CoreError> {
        let mut cancels = self.cancels.lock().map_err(|_| CoreError::LockPoisoned)?;
        if cancels.contains_key(query_id) {
            return Ok(false);
        }
        cancels.insert(query_id.to_owned(), flag);
        Ok(true)
    }

    pub fn clear_cancel(&self, query_id: &str) {
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(query_id);
        }
    }

    pub fn cancel(&self, query_id: &str) -> Result<bool, CoreError> {
        let cancels = self.cancels.lock().map_err(|_| CoreError::LockPoisoned)?;
        if let Some(flag) = cancels.get(query_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn owner(&self, connection_id: &str) -> Option<String> {
        self.owners.lock().ok().and_then(|owners| owners.get(connection_id).cloned())
    }

    pub fn set_owner(&self, connection_id: &str, label: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.insert(connection_id.to_owned(), label.to_owned());
        }
    }

    pub fn clear_owner(&self, connection_id: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(connection_id);
        }
    }

    /// Forgets every connection `label` owned and returns their ids.
    pub fn take_owned(&self, label: &str) -> Vec<String> {
        let Ok(mut owners) = self.owners.lock() else {
            return Vec::new();
        };
        let ids: Vec<String> =
            owners.iter().filter(|(_, owner)| *owner == label).map(|(id, _)| id.clone()).collect();
        for id in &ids {
            owners.remove(id);
        }
        ids
    }

    pub fn set_unsaved(&self, label: &str, unsaved: bool) {
        if let Ok(mut windows) = self.unsaved.lock() {
            if unsaved {
                windows.insert(label.to_owned());
            } else {
                windows.remove(label);
            }
        }
    }

    pub fn is_unsaved(&self, label: &str) -> bool {
        self.unsaved.lock().is_ok_and(|windows| windows.contains(label))
    }

    /// A window with unsaved edits, `main` first.
    pub fn first_unsaved(&self) -> Option<String> {
        let windows = self.unsaved.lock().ok()?;
        if windows.contains("main") {
            return Some("main".into());
        }
        windows.iter().next().cloned()
    }

    pub fn clear_unsaved(&self) {
        if let Ok(mut windows) = self.unsaved.lock() {
            windows.clear();
        }
    }
}

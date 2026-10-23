use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use gridl_core::{
    ConnectionId, CoreError, DatabaseDriver, DatabaseEngine, MysqlDriver, PostgresDriver,
    SafetySettings, SqliteDriver,
};

use crate::tunnel::SshTunnel;
use crate::vault::KeyringVault;

pub const KEYRING_SERVICE: &str = "app.gridl.desktop";

/// Process-wide sessions, cancellation flags, and the credential adapter.
pub struct AppState {
    sqlite: SqliteDriver,
    postgres: PostgresDriver,
    mysql: MysqlDriver,
    sessions: RwLock<HashMap<String, (DatabaseEngine, SafetySettings)>>,
    tunnels: Mutex<HashMap<String, SshTunnel>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub profile_lock: Arc<Mutex<()>>,
    /// Set by the UI while edits are pending, so closing the window asks first.
    pub unsaved: AtomicBool,
    pub vault: KeyringVault,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sqlite: SqliteDriver::new(),
            postgres: PostgresDriver::new(),
            mysql: MysqlDriver::new(),
            sessions: RwLock::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            profile_lock: Arc::new(Mutex::new(())),
            unsaved: AtomicBool::new(false),
            vault: KeyringVault::new(KEYRING_SERVICE),
        }
    }

    pub fn driver(&self, engine: DatabaseEngine) -> &dyn DatabaseDriver {
        match engine {
            DatabaseEngine::Sqlite => &self.sqlite,
            DatabaseEngine::Postgres => &self.postgres,
            DatabaseEngine::Mysql => &self.mysql,
        }
    }

    pub fn track(
        &self,
        id: &ConnectionId,
        engine: DatabaseEngine,
        safety: SafetySettings,
    ) -> Result<(), CoreError> {
        let mut sessions = self.sessions.write().map_err(|_| CoreError::LockPoisoned)?;
        sessions.insert(id.as_str().to_owned(), (engine, safety));
        Ok(())
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
            .map(|(engine, _)| *engine)
            .ok_or_else(|| CoreError::NotConnected(id.to_owned()))
    }

    /// The safety policy the session was opened with.
    pub fn safety(&self, id: &str) -> Result<SafetySettings, CoreError> {
        let sessions = self.sessions.read().map_err(|_| CoreError::LockPoisoned)?;
        sessions
            .get(id)
            .map(|(_, safety)| safety.clone())
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
}

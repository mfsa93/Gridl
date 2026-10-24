use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;

use crate::error::CoreError;
use crate::types::ConnectionId;

/// A session that releases its connections when closed.
#[async_trait]
pub(crate) trait Close: Send + Sync + 'static {
    async fn close(&self);
}

/// The open sessions of one driver, by connection id.
pub(crate) struct Sessions<S> {
    open: RwLock<HashMap<String, Arc<S>>>,
}

impl<S> Sessions<S> {
    pub(crate) fn new() -> Self {
        Self { open: RwLock::new(HashMap::new()) }
    }

    pub(crate) fn get(&self, id: &ConnectionId) -> Result<Arc<S>, CoreError> {
        let open = self.open.read().map_err(|_| CoreError::LockPoisoned)?;
        open.get(id.as_str())
            .cloned()
            .ok_or_else(|| CoreError::NotConnected(id.as_str().to_owned()))
    }

    /// Adds `session`, returning the one it replaces so the caller can close it.
    pub(crate) fn insert(
        &self,
        id: &ConnectionId,
        session: S,
    ) -> Result<Option<Arc<S>>, CoreError> {
        let mut open = self.open.write().map_err(|_| CoreError::LockPoisoned)?;
        Ok(open.insert(id.as_str().to_owned(), Arc::new(session)))
    }

    pub(crate) fn remove(&self, id: &ConnectionId) -> Result<Arc<S>, CoreError> {
        let mut open = self.open.write().map_err(|_| CoreError::LockPoisoned)?;
        open.remove(id.as_str()).ok_or_else(|| CoreError::NotConnected(id.as_str().to_owned()))
    }
}

impl<S: Close> Sessions<S> {
    /// Adds `session`. One it replaces closes in the background.
    pub(crate) fn open(&self, id: &ConnectionId, session: S) -> Result<(), CoreError> {
        if let Some(previous) = self.insert(id, session)? {
            close_in_background(previous);
        }
        Ok(())
    }

    /// Forgets the session at once and closes it in the background: closing
    /// waits for the server to say goodbye on every connection, and the user
    /// should not wait for that.
    pub(crate) fn close(&self, id: &ConnectionId) -> Result<(), CoreError> {
        close_in_background(self.remove(id)?);
        Ok(())
    }
}

fn close_in_background<S: Close>(session: Arc<S>) {
    tokio::spawn(async move { session.close().await });
}

/// The connections a session keeps open between queries: the editor's, so
/// `BEGIN`, `SET` and temporary tables carry over from one run to the next,
/// and the table browser's, so browsing never waits behind the editor.
pub(crate) struct Pinned<C> {
    editor: tokio::sync::Mutex<Option<C>>,
    browser: tokio::sync::Mutex<Option<C>>,
}

impl<C> Pinned<C> {
    pub(crate) fn new() -> Self {
        Self { editor: tokio::sync::Mutex::new(None), browser: tokio::sync::Mutex::new(None) }
    }

    /// The browser's slot for `browse` requests, the editor's otherwise.
    pub(crate) fn slot(&self, browse: bool) -> &tokio::sync::Mutex<Option<C>> {
        if browse {
            &self.browser
        } else {
            &self.editor
        }
    }

    /// Drops both connections unless a query is using them; closing a
    /// connection rolls back its open transaction.
    pub(crate) fn clear(&self) {
        for slot in [&self.editor, &self.browser] {
            if let Ok(mut connection) = slot.try_lock() {
                connection.take();
            }
        }
    }
}

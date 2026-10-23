use std::collections::HashMap;
use std::sync::RwLock;

use crate::error::CoreError;
use crate::secret::SecretString;

/// Port for secret storage. The desktop adapter talks to the OS keyring.
pub trait CredentialVault: Send + Sync {
    fn store(&self, account: &str, secret: &SecretString) -> Result<(), CoreError>;
    fn load(&self, account: &str) -> Result<SecretString, CoreError>;
    fn delete(&self, account: &str) -> Result<(), CoreError>;
}

/// In-memory vault used by tests and by anything that must not touch the OS.
#[derive(Debug, Default)]
pub struct MemoryVault {
    entries: RwLock<HashMap<String, String>>,
}

impl CredentialVault for MemoryVault {
    fn store(&self, account: &str, secret: &SecretString) -> Result<(), CoreError> {
        let mut entries = self.entries.write().map_err(|_| CoreError::LockPoisoned)?;
        entries.insert(account.to_owned(), secret.expose().to_owned());
        Ok(())
    }

    fn load(&self, account: &str) -> Result<SecretString, CoreError> {
        let entries = self.entries.read().map_err(|_| CoreError::LockPoisoned)?;
        entries.get(account).map_or_else(
            || Err(CoreError::Credential(format!("no secret for '{account}'"))),
            |secret| Ok(SecretString::new(secret.clone())),
        )
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        let mut entries = self.entries.write().map_err(|_| CoreError::LockPoisoned)?;
        entries.remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialVault, MemoryVault};
    use crate::secret::SecretString;

    #[test]
    fn memory_vault_roundtrip_and_secret_debug_is_redacted() {
        let vault = MemoryVault::default();
        let secret = SecretString::new("hunter2".into());
        assert!(!format!("{secret:?}").contains("hunter2"));
        vault.store("connection:demo", &secret).expect("store");
        let loaded = vault.load("connection:demo").expect("load");
        assert_eq!(loaded.expose(), "hunter2");
        vault.delete("connection:demo").expect("delete");
        assert!(vault.load("connection:demo").is_err());
    }
}

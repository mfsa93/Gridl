use gridl_core::{CoreError, CredentialVault, SecretString};

/// OS credential store: Keychain, Credential Manager, or Secret Service.
#[derive(Clone, Copy)]
pub struct KeyringVault {
    service: &'static str,
}

impl KeyringVault {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    pub async fn load_async(&self, account: &str) -> Result<SecretString, CoreError> {
        let vault = *self;
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || CredentialVault::load(&vault, &account))
            .await
            .map_err(|err| CoreError::Internal(err.to_string()))?
    }

    pub async fn store_async(&self, account: &str, secret: &SecretString) -> Result<(), CoreError> {
        let vault = *self;
        let account = account.to_owned();
        let copy = SecretString::new(secret.expose().to_owned());
        tokio::task::spawn_blocking(move || vault.store(&account, &copy))
            .await
            .map_err(|err| CoreError::Internal(err.to_string()))?
    }

    pub async fn delete_async(&self, account: &str) -> Result<(), CoreError> {
        let vault = *self;
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || vault.delete(&account))
            .await
            .map_err(|err| CoreError::Internal(err.to_string()))?
    }
}

impl CredentialVault for KeyringVault {
    fn store(&self, account: &str, secret: &SecretString) -> Result<(), CoreError> {
        let entry = keyring::Entry::new(self.service, account)
            .map_err(|err| CoreError::Credential(err.to_string()))?;
        entry.set_password(secret.expose()).map_err(|err| CoreError::Credential(err.to_string()))
    }

    fn load(&self, account: &str) -> Result<SecretString, CoreError> {
        let entry = keyring::Entry::new(self.service, account)
            .map_err(|err| CoreError::Credential(err.to_string()))?;
        let password =
            entry.get_password().map_err(|err| CoreError::Credential(err.to_string()))?;
        Ok(SecretString::new(password))
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        let entry = keyring::Entry::new(self.service, account)
            .map_err(|err| CoreError::Credential(err.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(CoreError::Credential(err.to_string())),
        }
    }
}

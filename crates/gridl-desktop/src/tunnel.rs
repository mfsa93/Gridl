use std::sync::Arc;

use gridl_core::{tr, CoreError, SecretString, SshAuth, SshSettings};
use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh::Error as RusshError;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

/// Local forward that stays open until dropped.
pub struct SshTunnel {
    local_port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl SshTunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct OpenedTunnel {
    pub tunnel: SshTunnel,
    pub fingerprint: String,
}

/// Opens an SSH session and forwards `target_host:target_port` to a local port.
pub async fn open(
    settings: &SshSettings,
    target_host: &str,
    target_port: u16,
    secret: Option<&SecretString>,
    trust_new_host: bool,
) -> Result<OpenedTunnel, CoreError> {
    let host = settings.host.as_deref().ok_or_else(|| {
        CoreError::InvalidConfig(tr!("the SSH server is not valid", "el servidor SSH no es válido"))
    })?;
    let username = settings.username.as_deref().ok_or_else(|| {
        CoreError::InvalidConfig(tr!("the SSH user is not valid", "el usuario SSH no es válido"))
    })?;
    let port = settings.port.unwrap_or(22);
    let gate = Arc::new(HostGate {
        expected: settings.host_fingerprint.clone(),
        trust_new: trust_new_host,
        seen: std::sync::Mutex::new(None),
    });
    let config = client::Config { nodelay: true, ..client::Config::default() };
    let mut handle = match client::connect(
        Arc::new(config),
        (host, port),
        ClientHandler { gate: Arc::clone(&gate) },
    )
    .await
    {
        Ok(handle) => handle,
        Err(err) => return Err(host_key_error(&gate, err)),
    };
    authenticate(&mut handle, settings, username, secret).await?;
    let fingerprint =
        gate.seen.lock().map_err(|_| CoreError::LockPoisoned)?.clone().ok_or_else(|| {
            CoreError::Database(tr!(
                "the SSH server didn't present a key",
                "el servidor SSH no presentó una clave"
            ))
        })?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let target_host = target_host.to_owned();
    let session = Arc::new(tokio::sync::Mutex::new(handle));
    let task = tokio::spawn(async move {
        let mut joins = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, peer)) = accepted else { break };
                    let session = Arc::clone(&session);
                    let target_host = target_host.clone();
                    joins.spawn(async move {
                        forward(session, socket, peer.port(), &target_host, target_port).await;
                    });
                }
                Some(_) = joins.join_next(), if !joins.is_empty() => {}
            }
        }
    });
    Ok(OpenedTunnel { tunnel: SshTunnel { local_port, task }, fingerprint })
}

async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    settings: &SshSettings,
    username: &str,
    secret: Option<&SecretString>,
) -> Result<(), CoreError> {
    let result = match settings.auth {
        SshAuth::Password => {
            let password = secret
                .map(SecretString::expose)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    CoreError::InvalidConfig(tr!(
                        "enter the SSH password",
                        "escribe la contraseña del túnel SSH"
                    ))
                })?;
            handle.authenticate_password(username, password).await.map_err(ssh_err)?
        }
        SshAuth::Key => {
            let path = settings.private_key.as_deref().ok_or_else(|| {
                CoreError::InvalidConfig(tr!(
                    "enter the path of the private key",
                    "indica la ruta de la llave privada"
                ))
            })?;
            let passphrase = secret.map(SecretString::expose).filter(|value| !value.is_empty());
            let key = russh::keys::load_secret_key(path, passphrase).map_err(|_| {
                CoreError::InvalidConfig(tr!(
                    "couldn't read the private key. If it's encrypted, enter its passphrase.",
                    "no se pudo leer la llave privada. Si está cifrada, escribe su frase."
                ))
            })?;
            let hash = if key.algorithm().is_rsa() {
                handle.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten()
            } else {
                None
            };
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle.authenticate_publickey(username, key).await.map_err(ssh_err)?
        }
    };
    if !matches!(result, AuthResult::Success) {
        return Err(CoreError::Database(tr!(
            "the SSH server rejected the authentication",
            "el servidor SSH rechazó la autenticación"
        )));
    }
    Ok(())
}

async fn forward(
    session: Arc<tokio::sync::Mutex<client::Handle<ClientHandler>>>,
    mut socket: tokio::net::TcpStream,
    origin_port: u16,
    target_host: &str,
    target_port: u16,
) {
    let _ = socket.set_nodelay(true);
    let opened = {
        let handle = session.lock().await;
        handle
            .channel_open_direct_tcpip(
                target_host,
                u32::from(target_port),
                "127.0.0.1",
                u32::from(origin_port),
            )
            .await
    };
    let Ok(channel) = opened else {
        return;
    };
    let mut remote = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut remote).await;
}

struct HostGate {
    expected: Option<String>,
    trust_new: bool,
    seen: std::sync::Mutex<Option<String>>,
}

struct ClientHandler {
    gate: Arc<HostGate>,
}

impl client::Handler for ClientHandler {
    type Error = RusshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.public_key().fingerprint(HashAlg::Sha256).to_string();
        if let Ok(mut seen) = self.gate.seen.lock() {
            *seen = Some(fingerprint.clone());
        }
        let trusted = self.gate.expected.as_deref() == Some(fingerprint.as_str())
            || (self.gate.expected.is_none() && self.gate.trust_new);
        Ok(trusted)
    }
}

fn host_key_error(gate: &HostGate, err: RusshError) -> CoreError {
    if matches!(err, RusshError::UnknownKey) {
        let seen = gate.seen.lock().ok().and_then(|seen| seen.clone());
        if let Some(fingerprint) = seen {
            if gate.expected.as_ref() != Some(&fingerprint) && gate.expected.is_some() {
                return CoreError::InvalidConfig(tr!(
                    "the SSH server's key changed. The current key is {fingerprint}",
                    "la clave del servidor SSH cambió. La clave actual es {fingerprint}"
                ));
            }
            return CoreError::InvalidConfig(tr!(
                "SSH server key: {fingerprint}. Confirm it to continue",
                "clave del servidor SSH: {fingerprint}. Confírmala para continuar"
            ));
        }
        return CoreError::InvalidConfig(tr!(
            "confirm the SSH server's key before connecting",
            "confirma la clave del servidor SSH antes de conectar"
        ));
    }
    ssh_err(err)
}

fn ssh_err(err: RusshError) -> CoreError {
    CoreError::Database(err.to_string())
}

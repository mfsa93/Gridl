use tiberius::{Query, Row};

use super::connect::{open_client, server_err};
use super::MsClient;
use crate::error::CoreError;

/// Idle connections kept for catalog reads and batches.
const IDLE_CONNECTIONS: usize = 4;

/// Opens connections and keeps a few idle ones. tiberius has no pool of its own.
pub(super) struct Pool {
    config: tiberius::Config,
    pub idle: std::sync::Mutex<Vec<MsClient>>,
}

impl Pool {
    pub(super) fn new(config: tiberius::Config) -> Self {
        Self { config, idle: std::sync::Mutex::new(Vec::new()) }
    }

    pub(super) async fn open(&self) -> Result<MsClient, CoreError> {
        open_client(self.config.clone()).await
    }

    /// An idle connection if there is one, and whether it came from the pool.
    pub(super) async fn get(&self) -> Result<(MsClient, bool), CoreError> {
        let idle = self.idle.lock().ok().and_then(|mut idle| idle.pop());
        match idle {
            Some(client) => Ok((client, true)),
            None => Ok((self.open().await?, false)),
        }
    }

    pub(super) fn put(&self, client: MsClient) {
        if let Ok(mut idle) = self.idle.lock() {
            if idle.len() < IDLE_CONNECTIONS {
                idle.push(client);
            }
        }
    }

    /// Every row of the first result. A pooled connection the server already
    /// closed fails once; the read is then retried on a new one.
    pub(super) async fn rows(&self, sql: &str, params: &[&str]) -> Result<Vec<Row>, CoreError> {
        let (mut client, pooled) = self.get().await?;
        let rows = match first_result(&mut client, sql, params).await {
            Err(_) if pooled => {
                client = self.open().await?;
                first_result(&mut client, sql, params).await?
            }
            other => other?,
        };
        self.put(client);
        Ok(rows)
    }
}

pub(super) async fn first_result(
    client: &mut MsClient,
    sql: &str,
    params: &[&str],
) -> Result<Vec<Row>, CoreError> {
    let mut query = Query::new(sql);
    for param in params {
        query.bind(*param);
    }
    query.query(client).await.map_err(server_err)?.into_first_result().await.map_err(server_err)
}

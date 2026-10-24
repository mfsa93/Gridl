//! The safety policy every statement goes through before it reaches a driver.

use gridl_core::{GuardMode, SafetySettings, Verdict};

use super::fail;
use crate::state::AppState;

/// Prefix of the error the UI turns into an authorization prompt or a block notice.
pub(crate) const GUARD_PREFIX: &str = "gridl-guard:";

/// Refuses SQL the connection's policy blocks, or that needs an authorization the request lacks.
pub(crate) fn guard(
    state: &AppState,
    id: &str,
    sql: &[&str],
    authorized: bool,
) -> Result<(), String> {
    let safety = state.safety(id).map_err(fail)?;
    let joined = sql.join(";\n");
    let verdict = gridl_core::evaluate(&safety, &joined);
    refuse(&safety, verdict, joined, authorized)
}

/// Like [`guard`] for restoring a backup, which rewrites structure and data.
pub(crate) fn guard_restore(
    state: &AppState,
    id: &str,
    description: String,
    authorized: bool,
) -> Result<(), String> {
    let safety = state.safety(id).map_err(fail)?;
    let verdict = gridl_core::evaluate_restore(&safety);
    refuse(&safety, verdict, description, authorized)
}

fn refuse(
    safety: &SafetySettings,
    verdict: Verdict,
    joined: String,
    authorized: bool,
) -> Result<(), String> {
    let refused = match verdict.mode {
        GuardMode::Allow => false,
        GuardMode::Confirm => !authorized,
        GuardMode::Block => true,
    };
    if !refused {
        return Ok(());
    }
    let payload = serde_json::json!({
        "mode": verdict.mode,
        "reason": verdict.reason,
        "dangerous": verdict.dangerous,
        "environment": safety.environment,
        "sql": joined,
    });
    Err(format!("{GUARD_PREFIX}{payload}"))
}

#[cfg(test)]
mod tests {
    use gridl_core::{
        ConnectionConfig, ConnectionId, DatabaseEngine, Environment, GuardMode, SafetySettings,
    };

    use super::{guard, guard_restore, GUARD_PREFIX};
    use crate::commands::query::timeout_message;
    use crate::state::AppState;

    pub(crate) fn sqlite_config(
        id: &str,
        database: &str,
        safety: SafetySettings,
    ) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: id.into(),
            engine: DatabaseEngine::Sqlite,
            database: database.into(),
            host: None,
            port: None,
            username: None,
            credential_account: None,
            group: None,
            read_only: false,
            create_if_missing: true,
            tls: gridl_core::TlsSettings::default(),
            ssh: gridl_core::SshSettings::default(),
            safety,
        }
    }

    fn session(state: &AppState, id: &str, writes: GuardMode, schema: GuardMode) {
        let safety = SafetySettings {
            environment: Environment::Staging,
            writes,
            schema,
            confirm_dangerous: true,
            timeout_secs: None,
        };
        state
            .track(&ConnectionId::new(id).expect("id"), sqlite_config(id, "x.db", safety), None)
            .expect("track");
    }

    #[test]
    fn guard_asks_blocks_and_lets_reads_through() {
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Confirm);
        session(&state, "prod", GuardMode::Block, GuardMode::Block);

        assert!(guard(&state, "stg", &["select * from t"], false).is_ok());
        let asked = guard(&state, "stg", &["update t set a = 1 where id = 2"], false)
            .expect_err("needs authorization");
        assert!(asked.starts_with(GUARD_PREFIX));
        assert!(asked.contains("\"mode\":\"confirm\""));
        assert!(guard(&state, "stg", &["update t set a = 1 where id = 2"], true).is_ok());

        let blocked = guard(&state, "prod", &["delete from t where id = 1"], true)
            .expect_err("blocked even when authorized");
        assert!(blocked.contains("\"mode\":\"block\""));
        assert!(guard(&state, "prod", &["select 1", "begin"], false).is_ok());
        let batch = guard(&state, "prod", &["select 1", "drop table t"], true).expect_err("batch");
        assert!(batch.contains("\"mode\":\"block\""));
    }

    #[test]
    fn messages_follow_the_language() {
        use gridl_core::{with_locale, Locale};

        assert_eq!(
            with_locale(Locale::En, || timeout_message(30)),
            "The query exceeded the 30 s limit and was cancelled."
        );
        assert_eq!(
            with_locale(Locale::Es, || timeout_message(30)),
            "La consulta superó el tiempo límite de 30 s y se canceló."
        );
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Confirm);
        let refusal = |locale| {
            with_locale(locale, || guard(&state, "stg", &["insert into t values (1)"], false))
                .expect_err("asks")
        };
        // The payload keeps its shape; only the reason is translated.
        let english = refusal(Locale::En);
        let spanish = refusal(Locale::Es);
        assert!(english.starts_with(GUARD_PREFIX) && spanish.starts_with(GUARD_PREFIX));
        assert!(english.contains(r#""reason":"modifies data""#), "{english}");
        assert!(spanish.contains(r#""reason":"modifica datos""#), "{spanish}");
    }

    #[test]
    fn import_and_restore_go_through_the_guard() {
        let state = AppState::new();
        session(&state, "stg", GuardMode::Confirm, GuardMode::Allow);
        session(&state, "open", GuardMode::Allow, GuardMode::Allow);
        session(&state, "ro", GuardMode::Block, GuardMode::Allow);

        let import = "INSERT INTO \"t\" (\"a\") VALUES (NULL)";
        assert!(guard(&state, "stg", &[import], false).is_err());
        assert!(guard(&state, "stg", &[import], true).is_ok());
        assert!(guard(&state, "open", &[import], false).is_ok());
        assert!(guard(&state, "ro", &[import], true).is_err());

        let asked = guard_restore(&state, "open", "-- restaurar x".into(), false)
            .expect_err("restore always asks");
        assert!(asked.contains("\"dangerous\":true"));
        assert!(guard_restore(&state, "open", "-- restaurar x".into(), true).is_ok());
        let blocked =
            guard_restore(&state, "ro", "-- restaurar x".into(), true).expect_err("block");
        assert!(blocked.contains("\"mode\":\"block\""));
    }
}

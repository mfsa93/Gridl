//! Safety policy per connection: which statements run freely, which need the
//! user's explicit authorization, and which are blocked.
//!
//! The classifier reads only the statement's shape (keywords outside quotes and
//! comments). It cannot see what a function does, so `SELECT purge()` counts as
//! a read. It errs on the side of caution for anything it does not recognize.

use serde::{Deserialize, Serialize};

/// Where a connection points. It only picks the suggested policy and the badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Local,
    Development,
    Staging,
    Production,
}

/// What happens to a class of statements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum GuardMode {
    #[default]
    Allow,
    Confirm,
    Block,
}

/// Saved per connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySettings {
    #[serde(default)]
    pub environment: Environment,
    /// INSERT, UPDATE, DELETE, MERGE, CALL, and anything unrecognized.
    #[serde(default)]
    pub writes: GuardMode,
    /// CREATE, ALTER, DROP, TRUNCATE, GRANT, and other DDL.
    #[serde(default)]
    pub schema: GuardMode,
    /// Always ask before DELETE or UPDATE without WHERE, DROP, and TRUNCATE.
    #[serde(default = "default_true")]
    pub confirm_dangerous: bool,
}

fn default_true() -> bool {
    true
}

impl Default for SafetySettings {
    fn default() -> Self {
        Self {
            environment: Environment::Local,
            writes: GuardMode::Allow,
            schema: GuardMode::Allow,
            confirm_dangerous: true,
        }
    }
}

/// Coarse class of one statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    /// Transaction control and session settings.
    Session,
    Read,
    Write,
    Schema,
}

/// What the guard decided for some SQL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub mode: GuardMode,
    /// Why, in words for the user. Empty when allowed.
    pub reason: String,
    /// True when the statement is destructive enough to ask for the database name.
    pub dangerous: bool,
}

impl Verdict {
    fn allow() -> Self {
        Self { mode: GuardMode::Allow, reason: String::new(), dangerous: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    word: String,
    depth: u32,
}

/// Keywords outside quotes and comments, grouped by top-level `;`.
fn statements(sql: &str) -> Vec<Vec<Token>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut all = Vec::new();
    let mut current = Vec::new();
    let mut depth: u32 = 0;
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        match char {
            '-' if next == Some('-') => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '#' => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '/' if next == Some('*') => {
                index += 2;
                while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                    index += 1;
                }
                index += 2;
                continue;
            }
            '\'' | '"' | '`' => {
                index += 1;
                while index < chars.len() {
                    if chars[index] == '\\' && char == '\'' {
                        index += 2;
                        continue;
                    }
                    if chars[index] == char {
                        if chars.get(index + 1) == Some(&char) {
                            index += 2;
                            continue;
                        }
                        break;
                    }
                    index += 1;
                }
            }
            '$' => {
                let tag_end = chars[index + 1..]
                    .iter()
                    .position(|item| !(item.is_alphanumeric() || *item == '_'))
                    .map(|offset| index + 1 + offset);
                if let Some(end) = tag_end.filter(|end| chars[*end] == '$') {
                    let tag: String = chars[index..=end].iter().collect();
                    let body: String = chars[end + 1..].iter().collect();
                    match body.find(&tag) {
                        Some(found) => {
                            index = end + 1 + body[..found].chars().count() + tag.chars().count()
                        }
                        None => index = chars.len(),
                    }
                    continue;
                }
            }
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                if !current.is_empty() {
                    all.push(std::mem::take(&mut current));
                }
            }
            '=' => current.push(Token { word: "=".into(), depth }),
            _ if char.is_alphabetic() || char == '_' => {
                let start = index;
                while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_')
                {
                    index += 1;
                }
                let word: String = chars[start..index].iter().collect();
                current.push(Token { word: word.to_ascii_uppercase(), depth });
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    if !current.is_empty() {
        all.push(current);
    }
    all
}

const READS: &[&str] = &["SELECT", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE", "HELP"];
const WRITES: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "COPY", "LOAD", "CALL", "DO",
    "EXEC", "EXECUTE", "LOCK", "HANDLER",
];
const SCHEMA: &[&str] = &[
    "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE", "REINDEX",
    "CLUSTER", "VACUUM", "ANALYZE", "REFRESH", "ATTACH", "DETACH", "OPTIMIZE", "REPAIR", "IMPORT",
    "SECURITY",
];
const SESSION: &[&str] = &[
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
    "SET",
    "RESET",
    "USE",
    "DISCARD",
    "PREPARE",
    "DEALLOCATE",
    "FETCH",
    "CLOSE",
    "DECLARE",
    "MOVE",
    "LISTEN",
    "UNLISTEN",
    "CHECKPOINT",
];

struct Shape {
    kind: StatementKind,
    danger: Option<&'static str>,
}

fn has_top(tokens: &[Token], word: &str) -> bool {
    tokens.iter().any(|token| token.depth == 0 && token.word == word)
}

fn shape(tokens: &[Token]) -> Shape {
    let Some(first) = tokens.first() else {
        return Shape { kind: StatementKind::Session, danger: None };
    };
    let verb = first.word.as_str();
    if verb == "EXPLAIN" {
        let analyzed = tokens.iter().skip(1).take(4).any(|token| token.word == "ANALYZE");
        if !analyzed {
            return Shape { kind: StatementKind::Read, danger: None };
        }
        let rest: Vec<Token> = tokens
            .iter()
            .skip(1)
            .skip_while(|token| {
                matches!(token.word.as_str(), "ANALYZE" | "VERBOSE" | "FORMAT" | "JSON" | "TEXT")
            })
            .cloned()
            .collect();
        return shape(&rest);
    }
    if verb == "WITH" {
        // A data-modifying CTE makes the whole statement a write.
        let main = tokens.iter().skip(1).find(|token| {
            token.depth == 0
                && matches!(
                    token.word.as_str(),
                    "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"
                )
        });
        let modifies = tokens
            .iter()
            .any(|token| matches!(token.word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
        let danger = match main.map(|token| token.word.as_str()) {
            Some("DELETE") | Some("UPDATE") if !has_top(tokens, "WHERE") => {
                Some(without_where(main))
            }
            _ => None,
        };
        let kind = if modifies { StatementKind::Write } else { StatementKind::Read };
        return Shape { kind, danger };
    }
    if verb == "PRAGMA" {
        let assigns = tokens.iter().any(|token| token.word == "=");
        let kind = if assigns { StatementKind::Schema } else { StatementKind::Read };
        return Shape { kind, danger: None };
    }
    if READS.contains(&verb) {
        // SELECT ... INTO creates a table (PostgreSQL) or writes a file (MySQL).
        let into = verb == "SELECT" && has_top(tokens, "INTO");
        let kind = if into { StatementKind::Write } else { StatementKind::Read };
        return Shape { kind, danger: None };
    }
    if SESSION.contains(&verb) {
        return Shape { kind: StatementKind::Session, danger: None };
    }
    if SCHEMA.contains(&verb) {
        let danger = match verb {
            "DROP" => Some("DROP elimina el objeto y sus datos"),
            "TRUNCATE" => Some("TRUNCATE vacía la tabla completa"),
            _ => None,
        };
        return Shape { kind: StatementKind::Schema, danger };
    }
    if WRITES.contains(&verb) {
        let danger = if matches!(verb, "DELETE" | "UPDATE") && !has_top(tokens, "WHERE") {
            Some(without_where(Some(first)))
        } else {
            None
        };
        return Shape { kind: StatementKind::Write, danger };
    }
    Shape { kind: StatementKind::Write, danger: None }
}

fn without_where(verb: Option<&Token>) -> &'static str {
    match verb.map(|token| token.word.as_str()) {
        Some("UPDATE") => "UPDATE sin WHERE cambia todas las filas",
        _ => "DELETE sin WHERE borra todas las filas",
    }
}

/// The most restrictive class among the statements in `sql`.
pub fn classify(sql: &str) -> StatementKind {
    statements(sql)
        .iter()
        .map(|tokens| shape(tokens).kind)
        .max_by_key(|kind| match kind {
            StatementKind::Session => 0,
            StatementKind::Read => 1,
            StatementKind::Write => 2,
            StatementKind::Schema => 3,
        })
        .unwrap_or(StatementKind::Session)
}

/// Decides what to do with every statement in `sql` under `policy`.
pub fn evaluate(policy: &SafetySettings, sql: &str) -> Verdict {
    let mut verdict = Verdict::allow();
    for tokens in statements(sql) {
        let shape = shape(&tokens);
        let (mode, what) = match shape.kind {
            StatementKind::Write => (policy.writes, "modifica datos"),
            StatementKind::Schema => (policy.schema, "cambia la estructura"),
            StatementKind::Read | StatementKind::Session => (GuardMode::Allow, ""),
        };
        let mut next = Verdict { mode, reason: what.to_owned(), dangerous: false };
        if let Some(danger) = shape.danger {
            next.dangerous = true;
            next.reason = danger.to_owned();
            if policy.confirm_dangerous && next.mode == GuardMode::Allow {
                next.mode = GuardMode::Confirm;
            }
        }
        if next.mode > verdict.mode
            || (next.mode == verdict.mode && next.dangerous && !verdict.dangerous)
        {
            verdict = next;
        }
    }
    if verdict.mode == GuardMode::Allow {
        return Verdict::allow();
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(writes: GuardMode, schema: GuardMode) -> SafetySettings {
        SafetySettings {
            environment: Environment::Staging,
            writes,
            schema,
            confirm_dangerous: true,
        }
    }

    #[test]
    fn classifies_common_statements() {
        assert_eq!(classify("select * from t"), StatementKind::Read);
        assert_eq!(classify("  -- hola\n SELECT 1"), StatementKind::Read);
        assert_eq!(classify("show tables"), StatementKind::Read);
        assert_eq!(classify("explain select 1"), StatementKind::Read);
        assert_eq!(classify("explain analyze delete from t where id = 1"), StatementKind::Write);
        assert_eq!(classify("insert into t values (1)"), StatementKind::Write);
        assert_eq!(
            classify("with x as (delete from t returning *) select * from x"),
            StatementKind::Write
        );
        assert_eq!(classify("with x as (select 1) select * from x"), StatementKind::Read);
        assert_eq!(classify("select * into nueva from t"), StatementKind::Write);
        assert_eq!(classify("alter table t add column c int"), StatementKind::Schema);
        assert_eq!(classify("begin"), StatementKind::Session);
        assert_eq!(classify("set search_path to x"), StatementKind::Session);
        assert_eq!(classify("pragma table_info(t)"), StatementKind::Read);
        assert_eq!(classify("pragma foreign_keys = off"), StatementKind::Schema);
        assert_eq!(classify("frobnicate everything"), StatementKind::Write);
        assert_eq!(classify("select 'delete from t; drop table x' as s"), StatementKind::Read);
        assert_eq!(classify("select $$ drop table x $$"), StatementKind::Read);
        assert_eq!(classify("select 1; delete from t where id = 2"), StatementKind::Write);
    }

    #[test]
    fn applies_the_policy() {
        let staging = policy(GuardMode::Confirm, GuardMode::Confirm);
        assert_eq!(evaluate(&staging, "select 1").mode, GuardMode::Allow);
        assert_eq!(evaluate(&staging, "update t set a = 1 where id = 2").mode, GuardMode::Confirm);
        let production = policy(GuardMode::Block, GuardMode::Block);
        assert_eq!(evaluate(&production, "delete from t where id = 1").mode, GuardMode::Block);
        assert_eq!(evaluate(&production, "select * from t").mode, GuardMode::Allow);
        assert_eq!(evaluate(&production, "begin").mode, GuardMode::Allow);
    }

    #[test]
    fn always_asks_before_destructive_statements() {
        let open = policy(GuardMode::Allow, GuardMode::Allow);
        let verdict = evaluate(&open, "delete from t");
        assert_eq!(verdict.mode, GuardMode::Confirm);
        assert!(verdict.dangerous);
        assert!(verdict.reason.contains("sin WHERE"));
        assert_eq!(
            evaluate(&open, "delete from t where id in (select id from u)").mode,
            GuardMode::Allow
        );
        assert_eq!(
            evaluate(&open, "update t set a = (select max(b) from u where u.x = t.x)").mode,
            GuardMode::Confirm
        );
        assert_eq!(evaluate(&open, "drop table t").mode, GuardMode::Confirm);
        assert_eq!(evaluate(&open, "truncate t").mode, GuardMode::Confirm);
        let unguarded = SafetySettings { confirm_dangerous: false, ..open };
        assert_eq!(evaluate(&unguarded, "delete from t").mode, GuardMode::Allow);
    }
}

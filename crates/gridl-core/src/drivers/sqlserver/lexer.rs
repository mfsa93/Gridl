//! A small T-SQL scanner: what is code, what is a string, a quoted name or a
//! comment. The driver uses it to number `?` placeholders, split `GO`
//! batches and judge what a statement may do.

use crate::error::CoreError;
use crate::tr;
use crate::value::SqlValue;

/// Character classes the T-SQL scanner below cares about.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Lexeme {
    /// Code outside strings, quoted names and comments.
    Code,
    Quoted,
    Comment,
}

/// Labels every character of `sql`: code, inside a string or quoted name, or
/// inside a comment. Brackets, double quotes and N'…' quote; `--` and `/* */`
/// (nested, as T-SQL allows) comment.
pub(super) fn lex(sql: &str) -> Vec<(char, Lexeme)> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        let close = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            out.push((c, Lexeme::Quoted));
            at += 1;
            while at < chars.len() {
                out.push((chars[at], Lexeme::Quoted));
                if chars[at] == close {
                    if chars.get(at + 1) == Some(&close) {
                        out.push((close, Lexeme::Quoted));
                        at += 2;
                        continue;
                    }
                    at += 1;
                    break;
                }
                at += 1;
            }
            continue;
        }
        if c == '-' && next == Some('-') {
            while at < chars.len() && chars[at] != '\n' {
                out.push((chars[at], Lexeme::Comment));
                at += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            let mut depth = 0;
            while at < chars.len() {
                if chars[at] == '/' && chars.get(at + 1) == Some(&'*') {
                    depth += 1;
                    out.push(('/', Lexeme::Comment));
                    out.push(('*', Lexeme::Comment));
                    at += 2;
                    continue;
                }
                if chars[at] == '*' && chars.get(at + 1) == Some(&'/') {
                    depth -= 1;
                    out.push(('*', Lexeme::Comment));
                    out.push(('/', Lexeme::Comment));
                    at += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                out.push((chars[at], Lexeme::Comment));
                at += 1;
            }
            continue;
        }
        out.push((c, Lexeme::Code));
        at += 1;
    }
    out
}

/// Lower-cased words of code, with their parenthesis depth.
fn words(sql: &str) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut depth: u32 = 0;
    for (c, kind) in lex(sql) {
        let part =
            kind == Lexeme::Code && (c.is_alphanumeric() || c == '_' || c == '@' || c == '#');
        if part {
            word.push(c.to_ascii_lowercase());
            continue;
        }
        if !word.is_empty() {
            out.push((std::mem::take(&mut word), depth));
        }
        if kind == Lexeme::Code {
            match c {
                '(' => depth += 1,
                ')' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    if !word.is_empty() {
        out.push((word, depth));
    }
    out
}

/// A plain INSERT, UPDATE, DELETE or MERGE that returns no rows, so it can run
/// where the server reports the count of rows it changed.
pub(super) fn counts_rows(batch: &str) -> bool {
    let words = words(batch);
    let Some((first, _)) = words.first() else {
        return false;
    };
    if !matches!(first.as_str(), "insert" | "update" | "delete" | "merge") {
        return false;
    }
    // INSERT … SELECT is one statement; any other top-level SELECT may return rows.
    let selects = words.iter().filter(|(word, depth)| *depth == 0 && word == "select").count();
    let allowed = usize::from(first == "insert");
    selects <= allowed
        && !words.iter().any(|(word, _)| word == "output" || word == "exec" || word == "execute")
}

/// Whether `sql` could change anything. Coarse on purpose: a read-only
/// connection refuses any statement that names a writing verb.
pub(super) fn writes(sql: &str) -> bool {
    words(sql).iter().enumerate().any(|(index, (word, _))| {
        matches!(
            word.as_str(),
            "insert"
                | "update"
                | "delete"
                | "merge"
                | "create"
                | "alter"
                | "drop"
                | "truncate"
                | "exec"
                | "execute"
                | "grant"
                | "revoke"
                | "deny"
                | "into"
                | "bulk"
                | "backup"
                | "restore"
                | "dbcc"
                | "kill"
                | "shutdown"
                | "reconfigure"
                | "use"
                | "commit"
        ) || (index == 0 && (word.starts_with("sp_") || word.starts_with("xp_")))
    })
}

/// Splits on lines holding only `GO`, the batch separator of SQL Server tools
/// (the server itself does not know it).
pub(super) fn split_batches(sql: &str) -> Vec<&str> {
    let kinds = lex(sql);
    let mut batches = Vec::new();
    let mut start = 0;
    let mut char_index = 0;
    let mut byte = 0;
    for line in sql.split_inclusive('\n') {
        let in_code = kinds.get(char_index).is_none_or(|(_, kind)| *kind == Lexeme::Code);
        if in_code && line.trim().eq_ignore_ascii_case("go") {
            batches.push(&sql[start..byte]);
            start = byte + line.len();
        }
        char_index += line.chars().count();
        byte += line.len();
    }
    batches.push(&sql[start..]);
    batches.into_iter().filter(|batch| !words(batch).is_empty()).collect()
}

/// Rewrites each `?` placeholder in code as `@P1`, `@P2`… Returns the SQL
/// and how many of `params` it used.
pub(super) fn number_params(sql: &str, params: &[SqlValue]) -> Result<(String, usize), CoreError> {
    let mut out = String::with_capacity(sql.len());
    let mut used = 0;
    for (c, kind) in lex(sql) {
        if c == '?' && kind == Lexeme::Code {
            if used == params.len() {
                return Err(CoreError::Database(tr!(
                    "the statement has more ? placeholders than parameters",
                    "la sentencia tiene más ? que parámetros"
                )));
            }
            used += 1;
            out.push_str(&format!("@P{used}"));
        } else {
            out.push(c);
        }
    }
    Ok((out, used))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_placeholders_outside_strings_names_and_comments() {
        let params = [SqlValue::Int(1), SqlValue::Int(2)];
        let (sql, used) =
            number_params("select ?, '?', \"?\", [?], ? -- ?\n/* ? /* ? */ ? */", &params)
                .expect("number");
        assert_eq!(sql, "select @P1, '?', \"?\", [?], @P2 -- ?\n/* ? /* ? */ ? */");
        assert_eq!(used, 2);
        assert!(number_params("select ?, ?, ?", &params).is_err());
    }

    #[test]
    fn splits_batches_on_go_lines_only() {
        let sql = "create table t (a int)\nGO\n  go  \nselect 'go'\n/*\ngo\n*/\nselect 1\ngo";
        assert_eq!(
            split_batches(sql),
            vec!["create table t (a int)\n", "select 'go'\n/*\ngo\n*/\nselect 1\n"]
        );
        assert_eq!(split_batches("select 1"), vec!["select 1"]);
    }

    #[test]
    fn counts_rows_only_for_statements_without_results() {
        assert!(counts_rows("update t set a = (select max(b) from u)"));
        assert!(counts_rows("insert into t select * from u"));
        assert!(counts_rows("DELETE FROM t WHERE a = 1"));
        assert!(!counts_rows("update t set a = 1 output inserted.a"));
        assert!(!counts_rows("update t set a = 1; select * from t"));
        assert!(!counts_rows("select * from t"));
        assert!(!counts_rows("with x as (select 1 a) delete from t"));
    }

    #[test]
    fn read_only_refuses_writing_verbs() {
        assert!(!writes("select * from t where name = 'drop'"));
        assert!(!writes("select [update] from t"));
        assert!(writes("select * into t2 from t"));
        assert!(writes("SELECT 1\nDELETE FROM t"));
        assert!(writes("sp_rename 'a', 'b'"));
    }
}

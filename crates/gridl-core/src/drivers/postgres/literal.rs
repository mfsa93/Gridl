//! Parameters written into the SQL as literals, so a query with parameters
//! still runs over the simple protocol and reads back as text.

use crate::error::CoreError;
use crate::tr;
use crate::value::SqlValue;

/// Writes `$1`, `$2`… as SQL literals so a query with parameters can still run over
/// the simple protocol and come back as text. Placeholders inside strings, quoted
/// identifiers, comments, and dollar-quoted bodies are left alone.
pub(super) fn inline_params(sql: &str, params: &[SqlValue]) -> Result<String, CoreError> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        match c {
            '\'' => {
                let escapes = at > 0
                    && matches!(chars[at - 1], 'e' | 'E')
                    && !chars
                        .get(at.wrapping_sub(2))
                        .is_some_and(|p| p.is_alphanumeric() || *p == '_');
                let start = at;
                at += 1;
                while at < chars.len() {
                    if escapes && chars[at] == '\\' {
                        at += 2;
                        continue;
                    }
                    if chars[at] == '\'' {
                        if chars.get(at + 1) == Some(&'\'') {
                            at += 2;
                            continue;
                        }
                        break;
                    }
                    at += 1;
                }
                at = (at + 1).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '"' => {
                let start = at;
                at += 1;
                while at < chars.len() && !(chars[at] == '"' && chars.get(at + 1) != Some(&'"')) {
                    at += if chars[at] == '"' { 2 } else { 1 };
                }
                at = (at + 1).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '-' if next == Some('-') => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '/' if next == Some('*') => {
                let start = at;
                let mut depth = 0;
                while at < chars.len() {
                    if chars[at] == '/' && chars.get(at + 1) == Some(&'*') {
                        depth += 1;
                        at += 2;
                    } else if chars[at] == '*' && chars.get(at + 1) == Some(&'/') {
                        depth -= 1;
                        at += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        at += 1;
                    }
                }
                out.extend(&chars[start..at.min(chars.len())]);
            }
            '$' => {
                let follows_word = at > 0
                    && (chars[at - 1].is_alphanumeric()
                        || chars[at - 1] == '_'
                        || chars[at - 1] == '$');
                if !follows_word && next.is_some_and(|n| n.is_ascii_digit()) {
                    let start = at + 1;
                    let mut end = start;
                    while end < chars.len() && chars[end].is_ascii_digit() {
                        end += 1;
                    }
                    let number: String = chars[start..end].iter().collect();
                    let index = number
                        .parse::<usize>()
                        .ok()
                        .filter(|n| *n >= 1 && *n <= params.len())
                        .ok_or_else(|| {
                            CoreError::Database(tr!(
                                "there is no parameter ${number}",
                                "no existe el parámetro ${number}"
                            ))
                        })?;
                    out.push_str(&sql_literal(&params[index - 1]));
                    at = end;
                    continue;
                }
                // A dollar-quoted body: $tag$ … $tag$.
                let mut end = at + 1;
                while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                    end += 1;
                }
                if !follows_word && chars.get(end) == Some(&'$') {
                    let tag: String = chars[at..=end].iter().collect();
                    let body_start = end + 1;
                    let rest: String = chars[body_start..].iter().collect();
                    let close = rest.find(&tag).map_or(chars.len(), |offset| {
                        body_start + rest[..offset].chars().count() + tag.chars().count()
                    });
                    out.extend(&chars[at..close]);
                    at = close;
                } else {
                    out.push(c);
                    at += 1;
                }
            }
            _ => {
                out.push(c);
                at += 1;
            }
        }
    }
    Ok(out)
}

/// A literal PostgreSQL reads the way it would read the bound value: strings stay
/// untyped so they take the type the context gives them, exactly like a parameter.
fn sql_literal(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "NULL".into(),
        SqlValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
        SqlValue::Int(value) if *value < 0 => format!("({value})"),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) if value.is_nan() => "'NaN'::float8".into(),
        SqlValue::Float(value) if value.is_infinite() => {
            if *value > 0.0 {
                "'Infinity'::float8".into()
            } else {
                "'-Infinity'::float8".into()
            }
        }
        SqlValue::Float(value) if *value < 0.0 => format!("({value:?})"),
        SqlValue::Float(value) => format!("{value:?}"),
        SqlValue::Text(text) => format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "\\'")),
        SqlValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("E'\\\\x{hex}'::bytea")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{inline_params, sql_literal};
    use crate::value::SqlValue;

    #[test]
    fn inlines_placeholders_outside_strings_comments_and_bodies() {
        let params = [SqlValue::Int(-5), SqlValue::Text("it's a \\ test".into())];
        let sql = "select $1, '$1', E'\\'$2', \"$1\", $2 -- $1\n/* $2 /* $1 */ */ $$ $1 $$, $q$ $2 $q$, x$1";
        assert_eq!(
            inline_params(sql, &params).expect("inline"),
            "select (-5), '$1', E'\\'$2', \"$1\", E'it\\'s a \\\\ test' -- $1\n/* $2 /* $1 */ */ $$ $1 $$, $q$ $2 $q$, x$1"
        );
        assert!(inline_params("select $3", &params).is_err());
    }

    #[test]
    fn literals_read_back_as_the_bound_value() {
        assert_eq!(sql_literal(&SqlValue::Null), "NULL");
        assert_eq!(sql_literal(&SqlValue::Bool(true)), "TRUE");
        assert_eq!(sql_literal(&SqlValue::Float(-1.5)), "(-1.5)");
        assert_eq!(sql_literal(&SqlValue::Float(f64::NAN)), "'NaN'::float8");
        assert_eq!(sql_literal(&SqlValue::Bytes(vec![0xde, 0xad])), "E'\\\\xdead'::bytea");
    }
}

//! Parameters written into the SQL as literals, so a query with parameters
//! still reads over the text protocol.

use crate::error::CoreError;
use crate::tr;
use crate::value::SqlValue;

/// Writes each `?` as a SQL literal so a query with parameters still reads over
/// the text protocol. Placeholders inside strings, quoted identifiers, and
/// comments are left alone. Text goes in as a hex literal, which reads the same
/// whatever the server's escaping mode.
pub(super) fn inline_params(sql: &str, params: &[SqlValue]) -> Result<String, CoreError> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut next_param = params.iter();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        match c {
            '\'' | '"' | '`' => {
                let start = at;
                at += 1;
                while at < chars.len() {
                    if chars[at] == '\\' && c != '`' {
                        at += 2;
                        continue;
                    }
                    if chars[at] == c {
                        if chars.get(at + 1) == Some(&c) {
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
            '#' => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '-' if next == Some('-') && chars.get(at + 2).is_none_or(|c| c.is_whitespace()) => {
                let start = at;
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                out.extend(&chars[start..at]);
            }
            '/' if next == Some('*') => {
                let start = at;
                at += 2;
                while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                    at += 1;
                }
                at = (at + 2).min(chars.len());
                out.extend(&chars[start..at]);
            }
            '?' => {
                let value = next_param.next().ok_or_else(|| {
                    CoreError::Database(tr!(
                        "the statement has more ? placeholders than parameters",
                        "la sentencia tiene más ? que parámetros"
                    ))
                })?;
                out.push_str(&sql_literal(value));
                at += 1;
            }
            _ => {
                out.push(c);
                at += 1;
            }
        }
    }
    Ok(out)
}

fn sql_literal(value: &SqlValue) -> String {
    let hex = |bytes: &[u8]| bytes.iter().map(|byte| format!("{byte:02X}")).collect::<String>();
    match value {
        SqlValue::Null => "NULL".into(),
        SqlValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
        SqlValue::Int(value) if *value < 0 => format!("({value})"),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) if *value < 0.0 => format!("({value:?})"),
        SqlValue::Float(value) => format!("{value:?}"),
        SqlValue::Text(text) if text.is_empty() => "''".into(),
        SqlValue::Text(text) => format!("_utf8mb4 X'{}'", hex(text.as_bytes())),
        SqlValue::Bytes(bytes) if bytes.is_empty() => "X''".into(),
        SqlValue::Bytes(bytes) => format!("X'{}'", hex(bytes)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inlines_placeholders_outside_strings_and_comments() {
        let params =
            [SqlValue::Int(-5), SqlValue::Text("it's".into()), SqlValue::Bytes(vec![0xde])];
        let sql = "select ?, '?', \"?\", `?`, ? # ?\n/* ? */ -- ?\n, 'a\\'?', ?";
        assert_eq!(
            inline_params(sql, &params).expect("inline"),
            "select (-5), '?', \"?\", `?`, _utf8mb4 X'69742773' # ?\n/* ? */ -- ?\n, 'a\\'?', X'DE'"
        );
        assert!(inline_params("select ?, ?, ?, ?", &params).is_err());
    }
}

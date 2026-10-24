//! Writes query results as CSV, JSON, or SQL INSERT statements, one row at a
//! time. The bytes match `frontend/src/workspace/export.ts`, so an export
//! streamed from the server equals one built from the rows in the grid.

use std::borrow::Cow;
use std::io::{self, Write};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;

use crate::engines::{spec as engine_spec, BooleanLiteral, BytesLiteral};
use crate::types::{ColumnDefinition, DatabaseEngine};
use crate::value::SqlValue;

/// File format of an export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

/// Largest integer JavaScript represents exactly, `2^53 - 1`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Streams rows into `out`. Call [`ExportWriter::begin`] once with the result
/// columns, [`ExportWriter::write_row`] per row, then [`ExportWriter::finish`].
pub struct ExportWriter<W: Write> {
    out: W,
    format: ExportFormat,
    engine: DatabaseEngine,
    table: String,
    columns: usize,
    /// JSON keys in the order `JSON.stringify` prints them, with the column that supplies each value.
    json_keys: Vec<(String, usize)>,
    /// `INSERT INTO <table> (<columns>) VALUES (` for SQL.
    insert_prefix: String,
    begun: bool,
    rows: u64,
}

impl<W: Write> ExportWriter<W> {
    /// `table` is the already-quoted target of SQL inserts.
    pub fn new(out: W, format: ExportFormat, engine: DatabaseEngine, table: &str) -> Self {
        Self {
            out,
            format,
            engine,
            table: table.to_owned(),
            columns: 0,
            json_keys: Vec::new(),
            insert_prefix: String::new(),
            begun: false,
            rows: 0,
        }
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    pub fn begin(&mut self, columns: &[ColumnDefinition]) -> io::Result<()> {
        if self.begun {
            return Ok(());
        }
        self.begun = true;
        self.columns = columns.len();
        match self.format {
            ExportFormat::Csv => {
                // The byte order mark lets spreadsheet apps detect UTF-8.
                self.out.write_all("\u{FEFF}".as_bytes())?;
                let header: Vec<Cow<'_, str>> =
                    columns.iter().map(|column| csv_cell(&column.name)).collect();
                self.out.write_all(header.join(",").as_bytes())?;
                self.out.write_all(b"\r\n")?;
            }
            ExportFormat::Json => self.json_keys = json_keys(columns),
            ExportFormat::Sql => {
                let names: Vec<String> =
                    columns.iter().map(|column| quote_ident(&column.name, self.engine)).collect();
                self.insert_prefix =
                    format!("INSERT INTO {} ({}) VALUES (", self.table, names.join(", "));
            }
        }
        Ok(())
    }

    pub fn write_row(&mut self, row: &[SqlValue]) -> io::Result<()> {
        if !self.begun {
            self.begin(&[])?;
        }
        let cell = |index: usize| row.get(index).unwrap_or(&SqlValue::Null);
        let mut line = String::new();
        match self.format {
            ExportFormat::Csv => {
                for index in 0..self.columns {
                    if index > 0 {
                        line.push(',');
                    }
                    line.push_str(&csv_cell(&plain_text(cell(index))));
                }
                line.push_str("\r\n");
            }
            ExportFormat::Json => {
                line.push_str(if self.rows == 0 { "[\n" } else { ",\n" });
                if self.json_keys.is_empty() {
                    line.push_str("  {}");
                } else {
                    line.push_str("  {\n");
                    for (position, (key, index)) in self.json_keys.iter().enumerate() {
                        if position > 0 {
                            line.push_str(",\n");
                        }
                        line.push_str("    ");
                        line.push_str(key);
                        line.push_str(": ");
                        line.push_str(&json_value(cell(*index)));
                    }
                    line.push_str("\n  }");
                }
            }
            ExportFormat::Sql => {
                line.push_str(&self.insert_prefix);
                for index in 0..self.columns {
                    if index > 0 {
                        line.push_str(", ");
                    }
                    line.push_str(&sql_literal(cell(index), self.engine));
                }
                line.push_str(");\n");
            }
        }
        self.out.write_all(line.as_bytes())?;
        self.rows += 1;
        Ok(())
    }

    /// Writes the closing bytes, flushes, and hands back the writer.
    pub fn finish(mut self) -> io::Result<W> {
        if !self.begun {
            self.begin(&[])?;
        }
        if self.format == ExportFormat::Json {
            let tail: &[u8] = if self.rows == 0 { b"[]\n" } else { b"\n]\n" };
            self.out.write_all(tail)?;
        }
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Quotes a column name with the engine's identifier quote.
pub fn quote_ident(name: &str, engine: DatabaseEngine) -> String {
    let quote = engine_spec(engine).sql.identifier_quote;
    let doubled = format!("{quote}{quote}");
    format!("{quote}{}{quote}", name.replace(quote, &doubled))
}

/// Quotes text as a string literal, doubling backslashes where the engine reads them as escapes.
pub fn text_literal(text: &str, engine: DatabaseEngine) -> String {
    let escaped: Cow<'_, str> = if engine_spec(engine).sql.backslash_escapes {
        text.replace('\\', "\\\\").into()
    } else {
        text.into()
    };
    let prefix = if engine_spec(engine).sql.national_text { "N" } else { "" };
    format!("{prefix}'{}'", escaped.replace('\'', "''"))
}

/// One cell as a SQL literal, like `sqlLiteral` in the frontend.
pub fn sql_literal(value: &SqlValue, engine: DatabaseEngine) -> String {
    match value {
        SqlValue::Null => "NULL".into(),
        SqlValue::Int(value) => value.to_string(),
        SqlValue::Float(value) if value.is_finite() => js_number(*value),
        SqlValue::Float(value) => format!("'{value}'"),
        SqlValue::Bool(value) => match engine_spec(engine).sql.booleans {
            BooleanLiteral::Number => if *value { "1" } else { "0" }.into(),
            BooleanLiteral::Keyword => if *value { "TRUE" } else { "FALSE" }.into(),
        },
        SqlValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            match engine_spec(engine).sql.bytes {
                BytesLiteral::EscapedHex => format!("'\\x{hex}'"),
                BytesLiteral::XHex => format!("X'{hex}'"),
                BytesLiteral::PrefixedHex if bytes.is_empty() => "0x".into(),
                BytesLiteral::PrefixedHex => format!("0x{hex}"),
            }
        }
        SqlValue::Text(text) => text_literal(text, engine),
    }
}

/// Formats a float like JavaScript's `String(number)`. Non-finite values use
/// the text they travel as over IPC (`inf`, `-inf`, `NaN`).
pub fn js_number(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value == 0.0 {
        return "0".into();
    }
    // `{:e}` prints the shortest digits that round-trip, as JavaScript does.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|char| *char != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let n = exponent + 1;
    let zeros = |count: i32| "0".repeat(usize::try_from(count).unwrap_or(0));
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", zeros(n - k))
    } else if 0 < n && n <= 21 {
        let split = usize::try_from(n).unwrap_or(0);
        format!("{}.{}", &digits[..split], &digits[split..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", zeros(-n))
    } else {
        let power = n - 1;
        let sign = if power >= 0 { '+' } else { '-' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", power.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", power.abs())
        }
    };
    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// Cell text for CSV, like `plainText` in the frontend.
fn plain_text(value: &SqlValue) -> Cow<'_, str> {
    match value {
        SqlValue::Null => "".into(),
        SqlValue::Bool(value) => if *value { "true" } else { "false" }.into(),
        SqlValue::Int(value) => value.to_string().into(),
        SqlValue::Float(value) => js_number(*value).into(),
        SqlValue::Text(text) => text.as_str().into(),
        SqlValue::Bytes(bytes) => BASE64.encode(bytes).into(),
    }
}

fn csv_cell(text: &str) -> Cow<'_, str> {
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\"")).into()
    } else {
        text.into()
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// One cell as JSON, like `jsonValue` in the frontend.
fn json_value(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "null".into(),
        SqlValue::Bool(value) => value.to_string(),
        SqlValue::Int(value) if value.abs() <= MAX_SAFE_INTEGER => value.to_string(),
        SqlValue::Int(value) => format!("\"{value}\""),
        SqlValue::Float(value) if value.is_finite() => js_number(*value),
        SqlValue::Float(value) => json_string(&value.to_string()),
        SqlValue::Text(text) => json_string(text),
        SqlValue::Bytes(bytes) => json_string(&BASE64.encode(bytes)),
    }
}

/// Keys of a JavaScript object built by assigning `record[name]` per column:
/// a repeated name keeps its first position and takes the last value,
/// array-index names come first in ascending order, and `__proto__` is not an
/// own property, so `JSON.stringify` leaves it out.
fn json_keys(columns: &[ColumnDefinition]) -> Vec<(String, usize)> {
    let mut keys: Vec<(&str, usize)> = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        if column.name == "__proto__" {
            continue;
        }
        match keys.iter_mut().find(|(name, _)| *name == column.name) {
            Some(entry) => entry.1 = index,
            None => keys.push((&column.name, index)),
        }
    }
    let (mut indexed, named): (Vec<_>, Vec<_>) =
        keys.into_iter().partition(|(name, _)| array_index(name).is_some());
    indexed.sort_by_key(|(name, _)| array_index(name));
    indexed.into_iter().chain(named).map(|(name, index)| (json_string(name), index)).collect()
}

fn array_index(name: &str) -> Option<u32> {
    if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if name.len() > 1 && name.starts_with('0') {
        return None;
    }
    name.parse::<u32>().ok().filter(|value| *value < u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            data_type: "text".into(),
            nullable: true,
            primary_key: false,
            default_value: None,
            options: Vec::new(),
            mode: None,
        }
    }

    fn export(
        format: ExportFormat,
        engine: DatabaseEngine,
        names: &[&str],
        rows: &[Vec<SqlValue>],
    ) -> String {
        let columns: Vec<ColumnDefinition> = names.iter().map(|name| column(name)).collect();
        let mut writer = ExportWriter::new(Vec::new(), format, engine, "\"t\"");
        writer.begin(&columns).expect("begin");
        for row in rows {
            writer.write_row(row).expect("row");
        }
        String::from_utf8(writer.finish().expect("finish")).expect("utf8")
    }

    #[test]
    fn formats_numbers_like_javascript() {
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1.5), "1.5");
        assert_eq!(js_number(-2.25), "-2.25");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(123456789.0), "123456789");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e21), "1.5e+21");
        assert_eq!(js_number(1e20), "100000000000000000000");
        assert_eq!(js_number(0.000001), "0.000001");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(-1.25e-9), "-1.25e-9");
        assert_eq!(js_number(f64::INFINITY), "inf");
        assert_eq!(js_number(f64::NAN), "NaN");
    }

    #[test]
    fn csv_has_bom_header_crlf_and_quotes() {
        let rows = vec![
            vec![
                SqlValue::Text("a,b".into()),
                SqlValue::Text("say \"hi\"".into()),
                SqlValue::Null,
                SqlValue::Bool(true),
            ],
            vec![
                SqlValue::Text("line\nbreak".into()),
                SqlValue::Bytes(b"hi".to_vec()),
                SqlValue::Int(-7),
                SqlValue::Float(2.5),
            ],
        ];
        let text =
            export(ExportFormat::Csv, DatabaseEngine::Postgres, &["id", "na,me", "c", "d"], &rows);
        assert_eq!(
            text,
            "\u{FEFF}id,\"na,me\",c,d\r\n\"a,b\",\"say \"\"hi\"\"\",,true\r\n\"line\nbreak\",aGk=,-7,2.5\r\n"
        );
        assert_eq!(export(ExportFormat::Csv, DatabaseEngine::Sqlite, &["a"], &[]), "\u{FEFF}a\r\n");
        let cr = export(
            ExportFormat::Csv,
            DatabaseEngine::Sqlite,
            &["a"],
            &[vec![SqlValue::Text("x\ry".into())]],
        );
        assert_eq!(cr, "\u{FEFF}a\r\n\"x\ry\"\r\n");
    }

    #[test]
    fn json_is_pretty_and_keeps_big_ints_as_text() {
        let rows = vec![
            vec![
                SqlValue::Int(MAX_SAFE_INTEGER),
                SqlValue::Int(MAX_SAFE_INTEGER + 1),
                SqlValue::Null,
                SqlValue::Text("q\"\n\u{1}".into()),
            ],
            vec![
                SqlValue::Int(-MAX_SAFE_INTEGER - 1),
                SqlValue::Float(1e21),
                SqlValue::Bool(false),
                SqlValue::Bytes(vec![0xff]),
            ],
        ];
        let text = export(ExportFormat::Json, DatabaseEngine::Mysql, &["a", "b", "c", "d"], &rows);
        assert_eq!(
            text,
            "[\n  {\n    \"a\": 9007199254740991,\n    \"b\": \"9007199254740992\",\n    \"c\": null,\n    \"d\": \"q\\\"\\n\\u0001\"\n  },\n  {\n    \"a\": \"-9007199254740992\",\n    \"b\": 1e+21,\n    \"c\": false,\n    \"d\": \"/w==\"\n  }\n]\n"
        );
        assert_eq!(export(ExportFormat::Json, DatabaseEngine::Mysql, &["a"], &[]), "[]\n");
        assert_eq!(
            export(ExportFormat::Json, DatabaseEngine::Mysql, &[], &[vec![]]),
            "[\n  {}\n]\n"
        );
    }

    #[test]
    fn json_keys_follow_javascript_object_order() {
        let rows = vec![vec![
            SqlValue::Int(1),
            SqlValue::Int(2),
            SqlValue::Int(3),
            SqlValue::Int(4),
            SqlValue::Int(5),
            SqlValue::Int(6),
        ]];
        let text = export(
            ExportFormat::Json,
            DatabaseEngine::Sqlite,
            &["name", "10", "2", "name", "__proto__", "01"],
            &rows,
        );
        assert_eq!(
            text,
            "[\n  {\n    \"2\": 3,\n    \"10\": 2,\n    \"name\": 4,\n    \"01\": 6\n  }\n]\n"
        );
    }

    #[test]
    fn sql_literals_follow_each_engine() {
        let row = vec![
            SqlValue::Null,
            SqlValue::Int(i64::MAX),
            SqlValue::Float(0.5),
            SqlValue::Bool(true),
            SqlValue::Bytes(vec![0xde, 0xad]),
            SqlValue::Text("it's a \\ path".into()),
            SqlValue::Float(f64::NEG_INFINITY),
        ];
        let names = ["a", "b\"c", "d`e", "f", "g", "h", "i"];
        let pg =
            export(ExportFormat::Sql, DatabaseEngine::Postgres, &names, std::slice::from_ref(&row));
        assert_eq!(
            pg,
            "INSERT INTO \"t\" (\"a\", \"b\"\"c\", \"d`e\", \"f\", \"g\", \"h\", \"i\") VALUES (NULL, 9223372036854775807, 0.5, TRUE, '\\xdead', 'it''s a \\ path', '-inf');\n"
        );
        let my =
            export(ExportFormat::Sql, DatabaseEngine::Mysql, &names, std::slice::from_ref(&row));
        assert_eq!(
            my,
            "INSERT INTO \"t\" (`a`, `b\"c`, `d``e`, `f`, `g`, `h`, `i`) VALUES (NULL, 9223372036854775807, 0.5, TRUE, X'dead', 'it''s a \\\\ path', '-inf');\n"
        );
        let lite = export(ExportFormat::Sql, DatabaseEngine::Sqlite, &names, &[row]);
        assert!(lite.contains(
            "VALUES (NULL, 9223372036854775807, 0.5, 1, X'dead', 'it''s a \\ path', '-inf');\n"
        ));
        assert_eq!(export(ExportFormat::Sql, DatabaseEngine::Sqlite, &["a"], &[]), "");
        assert_eq!(sql_literal(&SqlValue::Bool(false), DatabaseEngine::Sqlite), "0");
        assert_eq!(sql_literal(&SqlValue::Bool(false), DatabaseEngine::Mysql), "FALSE");
    }
}

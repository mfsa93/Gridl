//! Reads CSV files for the import dialog and turns them into multi-row INSERT
//! statements. Values travel as untyped string literals so each engine
//! coerces them to the column types.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::export::text_literal;
use crate::types::{BatchStatement, DatabaseEngine};

/// Data rows the preview returns after the header row.
pub const PREVIEW_ROWS: usize = 20;
/// Largest CSV file Gridl imports. The whole batch is built before it runs.
pub const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024;
/// Rows per INSERT statement.
pub const IMPORT_ROWS_PER_STATEMENT: usize = 500;
/// A statement closes early once its SQL passes this size.
const MAX_STATEMENT_BYTES: usize = 1024 * 1024;
/// The preview counts every row only for files up to this size.
const COUNT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
/// Bytes read to guess the delimiter.
const SNIFF_BYTES: usize = 64 * 1024;
const CANDIDATES: [u8; 4] = *b",;\t|";
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// First rows of a CSV file, for the import dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub delimiter: String,
    /// The first record. The dialog decides whether it is a header.
    pub headers: Vec<String>,
    /// Up to [`PREVIEW_ROWS`] records after the first.
    pub rows: Vec<Vec<String>>,
    /// Records after the first, when the file is small enough to count.
    pub total_rows: Option<u64>,
}

/// What to import and where. `table` and `columns` are already quoted.
#[derive(Debug, Clone)]
pub struct ImportPlan {
    pub engine: DatabaseEngine,
    pub delimiter: u8,
    pub has_header: bool,
    pub table: String,
    pub columns: Vec<String>,
    /// Per target column, the CSV column that fills it, or `None` to leave it out.
    pub mapping: Vec<Option<usize>>,
    /// Cell text that means NULL. Empty cells are NULL too.
    pub null_token: Option<String>,
}

/// INSERT statements built from a CSV file.
#[derive(Debug, Clone)]
pub struct ImportBatch {
    pub statements: Vec<BatchStatement>,
    /// Per statement, the first and last CSV line it covers and its row count.
    pub spans: Vec<(u64, u64, u64)>,
    pub rows: u64,
}

fn transfer(message: impl Into<String>) -> CoreError {
    CoreError::Transfer(message.into())
}

/// Reads a delimiter typed by the user: one ASCII character.
pub fn parse_delimiter(text: &str) -> Result<u8, CoreError> {
    match text.as_bytes() {
        [byte] if byte.is_ascii() && *byte != b'"' && *byte != b'\n' && *byte != b'\r' => Ok(*byte),
        _ => Err(transfer("El separador debe ser un solo carácter ASCII.")),
    }
}

/// Picks the candidate delimiter that splits the sample into the most
/// consistent records with more than one field. Comma when nothing fits.
pub fn sniff_delimiter(sample: &[u8]) -> u8 {
    let sample = sample.strip_prefix(BOM).unwrap_or(sample);
    // Drop a partial last line when the sample was cut.
    let sample = match sample.iter().rposition(|byte| *byte == b'\n') {
        Some(end) if sample.len() >= SNIFF_BYTES - BOM.len() => &sample[..=end],
        _ => sample,
    };
    let mut best = (b',', 0usize, 0usize);
    for candidate in CANDIDATES {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(candidate)
            .from_reader(sample);
        let mut counts = Vec::new();
        for record in reader.byte_records().take(PREVIEW_ROWS + 1) {
            match record {
                Ok(record) => counts.push(record.len()),
                Err(_) => break,
            }
        }
        let Some(&fields) = counts.first() else {
            continue;
        };
        if fields < 2 {
            continue;
        }
        let consistent = counts.iter().filter(|count| **count == fields).count();
        if (consistent, fields) > (best.1, best.2) {
            best = (candidate, consistent, fields);
        }
    }
    best.0
}

/// Opens `path` past a UTF-8 byte order mark, after checking its size.
fn open_csv(path: &Path) -> Result<(BufReader<File>, u64), CoreError> {
    let metadata = std::fs::metadata(path)
        .map_err(|err| transfer(format!("No se pudo abrir el archivo: {err}")))?;
    if !metadata.is_file() {
        return Err(transfer("La ruta no es un archivo."));
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(transfer("El archivo supera 512 MiB."));
    }
    let file =
        File::open(path).map_err(|err| transfer(format!("No se pudo abrir el archivo: {err}")))?;
    let mut reader = BufReader::with_capacity(SNIFF_BYTES, file);
    let starts_with_bom = reader.fill_buf()?.starts_with(BOM);
    if starts_with_bom {
        reader.consume(BOM.len());
    }
    Ok((reader, metadata.len()))
}

fn csv_reader<R: Read>(reader: R, delimiter: u8) -> csv::Reader<R> {
    csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(reader)
}

fn csv_error(err: &csv::Error) -> CoreError {
    let line = err.position().map(csv::Position::line);
    match line {
        Some(line) => transfer(format!("Línea {line}: el CSV no es válido ({err}).")),
        None => transfer(format!("El CSV no es válido: {err}")),
    }
}

fn lossy(record: &csv::ByteRecord) -> Vec<String> {
    record.iter().map(|field| String::from_utf8_lossy(field).into_owned()).collect()
}

/// The first record and the next [`PREVIEW_ROWS`]. The delimiter is guessed when `delimiter` is `None`.
pub fn preview_csv(path: &Path, delimiter: Option<&str>) -> Result<CsvPreview, CoreError> {
    let (mut reader, size) = open_csv(path)?;
    let delimiter = match delimiter.filter(|text| !text.is_empty()) {
        Some(text) => parse_delimiter(text)?,
        None => sniff_delimiter(reader.fill_buf()?),
    };
    let mut csv = csv_reader(reader, delimiter);
    let mut records = csv.byte_records();
    let headers = match records.next() {
        Some(record) => lossy(&record.map_err(|err| csv_error(&err))?),
        None => Vec::new(),
    };
    let mut rows = Vec::new();
    let mut total: u64 = 0;
    let countable = size <= COUNT_LIMIT_BYTES;
    for record in records {
        let record = record.map_err(|err| csv_error(&err))?;
        if rows.len() < PREVIEW_ROWS {
            rows.push(lossy(&record));
        } else if !countable {
            break;
        }
        total += 1;
    }
    Ok(CsvPreview {
        delimiter: char::from(delimiter).to_string(),
        headers,
        rows,
        total_rows: countable.then_some(total),
    })
}

/// The INSERT statements for `plan`, [`IMPORT_ROWS_PER_STATEMENT`] rows each.
pub fn build_import(path: &Path, plan: &ImportPlan) -> Result<ImportBatch, CoreError> {
    if plan.table.trim().is_empty() {
        return Err(transfer("Indica la tabla de destino."));
    }
    if plan.columns.len() != plan.mapping.len() {
        return Err(transfer("Cada columna de destino necesita su origen en el CSV."));
    }
    let active: Vec<(&str, usize)> = plan
        .columns
        .iter()
        .zip(&plan.mapping)
        .filter_map(|(column, source)| source.map(|index| (column.as_str(), index)))
        .collect();
    if active.is_empty() {
        return Err(transfer("Elige al menos una columna para importar."));
    }
    if active.iter().any(|(column, _)| column.trim().is_empty() || column.contains('\0')) {
        return Err(transfer("Hay una columna de destino sin nombre."));
    }
    let names: Vec<&str> = active.iter().map(|(column, _)| *column).collect();
    let prefix = format!("INSERT INTO {} ({}) VALUES ", plan.table, names.join(", "));
    let null_token = plan.null_token.as_deref().filter(|token| !token.is_empty());

    let (reader, _) = open_csv(path)?;
    let mut csv = csv_reader(reader, plan.delimiter);
    let mut batch = ImportBatch { statements: Vec::new(), spans: Vec::new(), rows: 0 };
    let mut sql = String::new();
    let mut span = (0u64, 0u64, 0u64);
    let mut record = csv::ByteRecord::new();
    let mut first = true;
    loop {
        let more = csv.read_byte_record(&mut record).map_err(|err| csv_error(&err))?;
        if !more {
            break;
        }
        if first {
            first = false;
            if plan.has_header {
                continue;
            }
        }
        let line = record.position().map_or(0, csv::Position::line);
        sql.push_str(if span.2 == 0 { prefix.as_str() } else { ", " });
        sql.push('(');
        for (position, (_, index)) in active.iter().enumerate() {
            if position > 0 {
                sql.push_str(", ");
            }
            let Some(field) = record.get(*index) else {
                return Err(transfer(format!(
                    "Línea {line}: tiene {} columnas y falta la columna {}.",
                    record.len(),
                    index + 1
                )));
            };
            let text = std::str::from_utf8(field)
                .map_err(|_| transfer(format!("Línea {line}: el texto no es UTF-8 válido.")))?;
            if text.is_empty() || Some(text) == null_token {
                sql.push_str("NULL");
            } else {
                sql.push_str(&text_literal(text, plan.engine));
            }
        }
        sql.push(')');
        if span.2 == 0 {
            span.0 = line;
        }
        span.1 = line;
        span.2 += 1;
        batch.rows += 1;
        if span.2 as usize >= IMPORT_ROWS_PER_STATEMENT || sql.len() >= MAX_STATEMENT_BYTES {
            batch
                .statements
                .push(BatchStatement { sql: std::mem::take(&mut sql), params: Vec::new() });
            batch.spans.push(span);
            span = (0, 0, 0);
        }
    }
    if span.2 > 0 {
        batch.statements.push(BatchStatement { sql, params: Vec::new() });
        batch.spans.push(span);
    }
    if batch.rows == 0 {
        return Err(transfer("El archivo no tiene filas para importar."));
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("gridl-import-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("dir");
        let path = directory.join(name);
        std::fs::write(&path, contents).expect("write");
        path
    }

    fn plan(engine: DatabaseEngine, mapping: Vec<Option<usize>>) -> ImportPlan {
        ImportPlan {
            engine,
            delimiter: b',',
            has_header: true,
            table: "\"t\"".into(),
            columns: vec!["\"a\"".into(), "\"b\"".into(), "\"c\"".into()],
            mapping,
            null_token: Some("NULL".into()),
        }
    }

    #[test]
    fn sniffs_common_delimiters() {
        assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3\n"), b',');
        assert_eq!(sniff_delimiter(b"a;b;c\n1,5;2;3\n4;5;6\n"), b';');
        assert_eq!(sniff_delimiter(b"a\tb\n1\t2\n"), b'\t');
        assert_eq!(sniff_delimiter(b"a|b|c\n1|2|3\n"), b'|');
        assert_eq!(sniff_delimiter(b"\xEF\xBB\xBFname;\"x;y\"\n1;2\n"), b';');
        assert_eq!(sniff_delimiter(b"solo\n1\n"), b',');
        assert_eq!(sniff_delimiter(b""), b',');
    }

    #[test]
    fn previews_header_and_rows_without_bom() {
        let mut text = b"\xEF\xBB\xBFid;name\n".to_vec();
        for index in 0..30 {
            text.extend_from_slice(format!("{index};\"n;{index}\"\n").as_bytes());
        }
        let path = temp_file("preview.csv", &text);
        let preview = preview_csv(&path, None).expect("preview");
        assert_eq!(preview.delimiter, ";");
        assert_eq!(preview.headers, vec!["id", "name"]);
        assert_eq!(preview.rows.len(), PREVIEW_ROWS);
        assert_eq!(preview.rows[1], vec!["1", "n;1"]);
        assert_eq!(preview.total_rows, Some(30));

        let forced = preview_csv(&path, Some(",")).expect("forced");
        assert_eq!(forced.delimiter, ",");
        assert_eq!(forced.headers, vec!["id;name"]);
        assert!(preview_csv(&path, Some("ab")).is_err());

        let empty = temp_file("empty.csv", b"");
        let preview = preview_csv(&empty, None).expect("empty");
        assert!(preview.headers.is_empty());
        assert_eq!(preview.total_rows, Some(0));
    }

    #[test]
    fn builds_escaped_multi_row_inserts() {
        let path = temp_file("rows.csv", b"a,b,c\n1,it's,x\\y\n2,,NULL\n\"3\",\"multi\nline\",z\n");
        let batch = build_import(&path, &plan(DatabaseEngine::Mysql, vec![Some(0), None, Some(2)]))
            .expect("build");
        assert_eq!(batch.rows, 3);
        assert_eq!(batch.statements.len(), 1);
        assert_eq!(
            batch.statements[0].sql,
            "INSERT INTO \"t\" (\"a\", \"c\") VALUES ('1', 'x\\\\y'), ('2', NULL), ('3', 'z')"
        );
        assert_eq!(batch.spans, vec![(2, 4, 3)]);

        let batch =
            build_import(&path, &plan(DatabaseEngine::Postgres, vec![Some(1), Some(0), Some(2)]))
                .expect("build");
        assert_eq!(
            batch.statements[0].sql,
            "INSERT INTO \"t\" (\"a\", \"b\", \"c\") VALUES ('it''s', '1', 'x\\y'), (NULL, '2', NULL), ('multi\nline', '3', 'z')"
        );
    }

    #[test]
    fn splits_large_files_and_names_bad_lines() {
        let mut text = String::new();
        for index in 0..1_201 {
            text.push_str(&format!("{index},{index},{index}\n"));
        }
        let path = temp_file("many.csv", text.as_bytes());
        let mut no_header = plan(DatabaseEngine::Sqlite, vec![Some(0), Some(1), Some(2)]);
        no_header.has_header = false;
        let batch = build_import(&path, &no_header).expect("build");
        assert_eq!(batch.rows, 1_201);
        assert_eq!(batch.statements.len(), 3);
        assert_eq!(batch.spans[0], (1, 500, 500));
        assert_eq!(batch.spans[2], (1_001, 1_201, 201));

        let short = temp_file("short.csv", b"a,b,c\n1,2,3\n4,5\n");
        let err =
            build_import(&short, &plan(DatabaseEngine::Sqlite, vec![Some(0), Some(1), Some(2)]))
                .expect_err("short row");
        assert!(err.to_string().starts_with("Línea 3:"), "{err}");

        let invalid = temp_file("latin1.csv", b"a,b,c\n1,\xE9,3\n");
        let err =
            build_import(&invalid, &plan(DatabaseEngine::Sqlite, vec![Some(0), Some(1), Some(2)]))
                .expect_err("utf8");
        assert!(err.to_string().contains("Línea 2"), "{err}");

        let header_only = temp_file("header.csv", b"a,b,c\n");
        assert!(build_import(
            &header_only,
            &plan(DatabaseEngine::Sqlite, vec![Some(0), None, None])
        )
        .is_err());
        assert!(build_import(&path, &plan(DatabaseEngine::Sqlite, vec![None, None, None])).is_err());
        assert!(build_import(&path, &plan(DatabaseEngine::Sqlite, vec![Some(0)])).is_err());
    }
}

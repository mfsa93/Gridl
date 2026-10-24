import { engineSpec } from "../engines";
import { quoteIdent, type ColumnDefinition, type DatabaseEngine, type SqlValue } from "../lib/api";

export type ExportFormat = "csv" | "json" | "sql";

export const exportFormats: { format: ExportFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "json", label: "JSON" },
  { format: "sql", label: "SQL INSERT" },
];

/** Serializes rows in the chosen format. `table` names the target of SQL inserts. */
export function exportRows(
  format: ExportFormat,
  columns: ColumnDefinition[],
  rows: SqlValue[][],
  engine: DatabaseEngine,
  table: string,
): string {
  if (format === "csv") return toCsv(columns, rows);
  if (format === "json") return toJson(columns, rows);
  return toInserts(columns, rows, engine, table);
}

/** Tab-separated text for the clipboard, the format spreadsheets paste. */
export function toTsv(columns: ColumnDefinition[], rows: SqlValue[][], header = true): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  const lines = rows.map((row) => columns.map((_, index) => clean(plainText(row[index]))).join("\t"));
  if (header) lines.unshift(columns.map((column) => clean(column.name)).join("\t"));
  return lines.join("\n");
}

function plainText(value: SqlValue | undefined): string {
  if (!value || value.t === "null") return "";
  if (value.t === "bool") return value.v ? "true" : "false";
  return String(value.v);
}

function toCsv(columns: ColumnDefinition[], rows: SqlValue[][]): string {
  const cell = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
  const lines = [columns.map((column) => cell(column.name)).join(",")];
  for (const row of rows) lines.push(columns.map((_, index) => cell(plainText(row[index]))).join(","));
  // The byte order mark lets spreadsheet apps detect UTF-8.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function jsonValue(value: SqlValue | undefined): unknown {
  if (!value || value.t === "null") return null;
  if (value.t === "int") {
    const parsed = Number(value.v);
    return Number.isSafeInteger(parsed) ? parsed : value.v;
  }
  return value.v;
}

export function toJson(columns: ColumnDefinition[], rows: SqlValue[][]): string {
  const records = rows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column.name] = jsonValue(row[index]);
    });
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function sqlLiteral(value: SqlValue | undefined, engine: DatabaseEngine): string {
  if (!value || value.t === "null") return "NULL";
  if (value.t === "int") return value.v;
  if (value.t === "float") return Number.isFinite(value.v) ? String(value.v) : `'${String(value.v)}'`;
  if (value.t === "bool") {
    if (engineSpec(engine).sql.booleans === "number") return value.v ? "1" : "0";
    return value.v ? "TRUE" : "FALSE";
  }
  if (value.t === "bytes") {
    const hex = base64Hex(value.v);
    const style = engineSpec(engine).sql.bytes;
    if (style === "prefixed-hex") return `0x${hex}`;
    return style === "escaped-hex" ? `'\\x${hex}'` : `X'${hex}'`;
  }
  return textLiteral(value.v, engine);
}

/** Quotes text as a string literal, doubling backslashes where the engine reads them as escapes. */
export function textLiteral(text: string, engine: DatabaseEngine): string {
  const { backslashEscapes, nationalText } = engineSpec(engine).sql;
  const escaped = backslashEscapes ? text.replaceAll("\\", "\\\\") : text;
  return `${nationalText ? "N" : ""}'${escaped.replaceAll("'", "''")}'`;
}

function base64Hex(encoded: string): string {
  try {
    const binary = atob(encoded);
    let hex = "";
    for (let index = 0; index < binary.length; index += 1) {
      hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return "";
  }
}

function toInserts(columns: ColumnDefinition[], rows: SqlValue[][], engine: DatabaseEngine, table: string): string {
  const names = columns.map((column) => quoteIdent(column.name)).join(", ");
  const lines = rows.map((row) => {
    const values = columns.map((_, index) => sqlLiteral(row[index], engine)).join(", ");
    return `INSERT INTO ${table} (${names}) VALUES (${values});`;
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

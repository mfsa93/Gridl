import { engineSpec } from "../engines";
import { CodedError } from "../lib/errors";
import { t } from "../lib/i18n";
import { foreignKeyClause, type FkAction } from "./relations";
import { quoteIdent, qualifiedName, type ColumnDefinition, type DatabaseEngine, type SqlValue, type TableSchema } from "../lib/api";

export type CellField = {
  text: string;
  isNull: boolean;
};

export type NewColumn = {
  name: string;
  dataType: string;
  /** `255` for sized types, `10,2` for numeric ones. */
  size: string;
  defaultValue: string;
  primaryKey: boolean;
  required: boolean;
  unique: boolean;
  /** Foreign key to one column of another table. */
  reference: { schema: string | null; table: string; column: string; onDelete: string } | null;
};

export type SizeKind = "plain" | "length" | "numeric";

/** Whether a type takes a length, a precision and scale, or nothing. */
export function sizeKind(engine: DatabaseEngine, dataType: string): SizeKind {
  return columnTypeSpecs(engine).find((item) => item.name === dataType)?.kind ?? "plain";
}

/** The type a column needs to reference `refType`: serial keys are plain integers on the other side. */
export function referencingType(engine: DatabaseEngine, refType: string): string | null {
  const type = refType.trim().toLowerCase();
  const names = columnTypes(engine);
  const pick = (name: string) => names.find((item) => item.toLowerCase() === name.toLowerCase()) ?? null;
  const { referenceRules, referenceFallback } = engineSpec(engine).structure;
  for (const [pattern, target] of referenceRules) {
    if (new RegExp(pattern, "i").test(type)) return pick(target);
  }
  return pick(type) ?? pick(type.replace(/\(.*\)/, "").trim()) ?? (referenceFallback ? pick(referenceFallback) : null);
}

export function isGeneratedType(engine: DatabaseEngine, dataType: string): boolean {
  return Boolean(columnTypeSpecs(engine).find((item) => item.name === dataType)?.generated);
}

export type AddedColumn = {
  name: string;
  dataType: string;
  length: string;
  precision: string;
  scale: string;
  nullable: boolean;
  unique: boolean;
  defaultValue: string;
};

export type ColumnDraft = {
  key: string;
  originalName: string | null;
  name: string;
  dataType: string;
  length: string;
  precision: string;
  scale: string;
  nullable: boolean;
  defaultValue: string;
  primaryKey: boolean;
  dropped: boolean;
  originalDataType: string;
  originalLength: string;
  originalPrecision: string;
  originalScale: string;
  originalNullable: boolean;
  originalDefault: string;
};

type ColumnTypeSpec = {
  name: string;
  kind: "plain" | "length" | "numeric";
  generated?: boolean;
};




const postgresCasts: Record<string, string> = {
  text: "text",
  "character varying": "varchar",
  character: "character",
  integer: "integer",
  bigint: "bigint",
  smallint: "smallint",
  boolean: "boolean",
  numeric: "numeric",
  decimal: "numeric",
  real: "real",
  "double precision": "double precision",
  date: "date",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  uuid: "uuid",
  jsonb: "jsonb",
  json: "json",
};

export function columnTypeSpecs(engine: DatabaseEngine): ColumnTypeSpec[] {
  return engineSpec(engine).structure.columnTypes;
}

export function columnTypes(engine: DatabaseEngine): string[] {
  return columnTypeSpecs(engine).map((type) => type.name);
}

export function listSchemasSql(): string {
  return `select schema_name
from information_schema.schemata
where schema_name not in ('pg_catalog', 'information_schema')
  and schema_name not like 'pg\\_%' escape '\\'
order by schema_name`;
}

export function schemaNameFrom(value: SqlValue | undefined): string | null {
  if (!value || value.t !== "text") return null;
  const name = value.v.trim();
  return name.length > 0 ? name : null;
}

export function createSchemaSql(name: string): string {
  return `create schema ${quoteIdent(requireName(name))}`;
}

export function renameSchemaSql(from: string, to: string): string {
  return `alter schema ${quoteIdent(requireName(from))} rename to ${quoteIdent(requireName(to))}`;
}

export function dropSchemaSql(name: string): string {
  return `drop schema ${quoteIdent(requireName(name))}`;
}

export function addColumnSql(table: TableSchema, column: AddedColumn, engine: DatabaseEngine): string {
  const spec = columnTypeSpecs(engine).find((item) => item.name === column.dataType);
  if (!spec) throw new Error(t("changes.pickType"));
  const type = columnTypeClause(spec, column);
  const parts = [`alter table ${qualifiedName(table)} add column ${quoteIdent(requireName(column.name))} ${type}`];
  if (!spec.generated) {
    const fallback = defaultClause(column.defaultValue);
    if (fallback) parts.push(fallback);
    if (!column.nullable) {
      if (!fallback) throw new Error(t("changes.requiredNeedsDefault"));
      parts.push("not null");
    }
  }
  if (column.unique) {
    if (!engineSpec(engine).structure.uniqueOnAdd) throw new Error(t("changes.noUniqueOnAdd", { engine: engineSpec(engine).name }));
    parts.push("unique");
  }
  return parts.join(" ");
}

export function dropColumnSql(table: TableSchema, name: string): string {
  return `alter table ${qualifiedName(table)} drop column ${quoteIdent(requireName(name))}`;
}

const catalogTypes: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time without time zone": "time",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
};

export function parseColumnType(dataType: string, engine: DatabaseEngine): { name: string; length: string; precision: string; scale: string } {
  const raw = dataType.trim().toLowerCase().replace(/\s+/g, " ");
  const match = /^(.*?)(?:\((\d+)(?:\s*,\s*(\d+))?\))?$/.exec(raw);
  const base = (match?.[1] ?? raw).trim();
  const mapped = catalogTypes[base] ?? base;
  const spec = columnTypeSpecs(engine).find((item) => item.name.toLowerCase() === mapped);
  const hasScale = Boolean(match?.[3]);
  return {
    name: spec?.name ?? dataType.trim(),
    length: hasScale ? "" : (match?.[2] ?? ""),
    precision: hasScale ? (match?.[2] ?? "") : "",
    scale: match?.[3] ?? "",
  };
}

export function columnDrafts(table: TableSchema, engine: DatabaseEngine): ColumnDraft[] {
  return table.columns.map((column) => {
    const parsed = parseColumnType(column.dataType, engine);
    return {
      key: column.name,
      originalName: column.name,
      name: column.name,
      dataType: parsed.name,
      length: parsed.length,
      precision: parsed.precision,
      scale: parsed.scale,
      nullable: column.nullable,
      defaultValue: column.defaultValue ?? "",
      primaryKey: column.primaryKey,
      dropped: false,
      originalDataType: parsed.name,
      originalLength: parsed.length,
      originalPrecision: parsed.precision,
      originalScale: parsed.scale,
      originalNullable: column.nullable,
      originalDefault: column.defaultValue ?? "",
    };
  });
}

export function blankColumnDraft(engine: DatabaseEngine, key: string): ColumnDraft {
  const dataType = columnTypes(engine)[0] ?? "text";
  return {
    key,
    originalName: null,
    name: "",
    dataType,
    length: "",
    precision: "",
    scale: "",
    nullable: true,
    defaultValue: "",
    primaryKey: false,
    dropped: false,
    originalDataType: dataType,
    originalLength: "",
    originalPrecision: "",
    originalScale: "",
    originalNullable: true,
    originalDefault: "",
  };
}

export function columnDraftDirty(row: ColumnDraft, engine: DatabaseEngine): boolean {
  if (!row.originalName) return !isUntouchedDraft(row, engine);
  if (row.dropped) return true;
  return row.name.trim() !== row.originalName
    || row.dataType !== row.originalDataType
    || row.length.trim() !== row.originalLength
    || row.precision.trim() !== row.originalPrecision
    || row.scale.trim() !== row.originalScale
    || row.nullable !== row.originalNullable
    || row.defaultValue.trim() !== row.originalDefault.trim();
}

export function columnChangeSql(table: TableSchema, rows: ColumnDraft[], engine: DatabaseEngine): string[] {
  const active = rows.filter((row) => row.originalName !== null || !isUntouchedDraft(row, engine));
  const names = new Set<string>();
  for (const row of active) {
    if (row.dropped) continue;
    const name = requireName(row.name).toLowerCase();
    if (names.has(name)) throw new Error(t("changes.duplicateColumn", { name: row.name.trim() }));
    names.add(name);
  }
  const statements: string[] = [];
  const qualified = qualifiedName(table);
  for (const row of active) {
    if (row.originalName || row.dropped) continue;
    statements.push(addColumnSql(table, addedFrom(row), engine));
  }
  for (const row of active) {
    if (!row.originalName || row.dropped) continue;
    const next = requireName(row.name);
    const previous = requireName(row.originalName);
    if (next !== previous) statements.push(`alter table ${qualified} rename column ${quoteIdent(previous)} to ${quoteIdent(next)}`);
    const typeDiff = row.dataType !== row.originalDataType || row.length.trim() !== row.originalLength || row.precision.trim() !== row.originalPrecision || row.scale.trim() !== row.originalScale;
    const nullDiff = row.nullable !== row.originalNullable;
    const defaultDiff = row.defaultValue.trim() !== row.originalDefault.trim();
    if (!typeDiff && !nullDiff && !defaultDiff) continue;
    if (!engineSpec(engine).structure.alterColumns) throw new Error(t("changes.onlyRenameAddDrop", { engine: engineSpec(engine).name }));
    const current = quoteIdent(next);
    if (engineSpec(engine).structure.ddl === "mysql") {
      statements.push(mysqlModifySql(engine, qualified, current, row, typeDiff));
      continue;
    }
    if (typeDiff) {
      const type = draftTypeClause(row, engine);
      statements.push(`alter table ${qualified} alter column ${current} type ${type} using ${current}::${type}`);
    }
    if (defaultDiff) {
      const text = row.defaultValue.trim();
      statements.push(text
        ? `alter table ${qualified} alter column ${current} set default ${defaultLiteral(text)}`
        : `alter table ${qualified} alter column ${current} drop default`);
    }
    if (nullDiff) {
      statements.push(row.nullable
        ? `alter table ${qualified} alter column ${current} drop not null`
        : `alter table ${qualified} alter column ${current} set not null`);
    }
  }
  for (const row of active) {
    if (row.dropped && row.originalName) statements.push(dropColumnSql(table, row.originalName));
  }
  return statements;
}

/** The MySQL style restates the whole column definition, so type, nullability, and default go together. */
function mysqlModifySql(engine: DatabaseEngine, qualified: string, column: string, row: ColumnDraft, typeDiff: boolean): string {
  const spec = columnTypeSpecs(engine).find((item) => item.name === row.dataType);
  const type = spec ? columnTypeClause(spec, addedFrom(row)) : typeDiff ? draftTypeClause(row, engine) : row.dataType;
  const parts = [`alter table ${qualified} modify column ${column} ${type}`, row.nullable ? "null" : "not null"];
  const fallback = row.defaultValue.trim();
  if (fallback.toLowerCase() === "auto_increment") parts.push("auto_increment");
  else if (fallback) parts.push(`default ${defaultLiteral(fallback)}`);
  return parts.join(" ");
}

export function createTableSql(schema: string | null, tableName: string, columns: NewColumn[], engine: DatabaseEngine): string {
  const name = requireName(tableName);
  const usable = columns.map((column) => ({
    ...column,
    name: requireName(column.name),
    dataType: requireType(column.dataType, engine),
  }));
  if (usable.length === 0) throw new Error(t("changes.addColumn"));
  const seen = new Set<string>();
  for (const column of usable) {
    const key = column.name.toLowerCase();
    if (seen.has(key)) throw new Error(t("changes.duplicateColumn", { name: column.name }));
    seen.add(key);
  }
  const keys = usable.filter((column) => column.primaryKey).map((column) => quoteIdent(column.name));
  const lines = usable.map((column) => {
    const spec = columnTypeSpecs(engine).find((item) => item.name === column.dataType);
    if (!spec) throw new Error(t("changes.pickType"));
    const [first = "", second = ""] = column.size.split(",").map((part) => part.trim());
    const sizedColumn = {
      name: column.name,
      dataType: column.dataType,
      length: spec.kind === "length" ? first : "",
      precision: spec.kind === "numeric" ? first : "",
      scale: spec.kind === "numeric" ? second : "",
      nullable: !column.required,
      unique: column.unique,
      defaultValue: column.defaultValue,
    };
    let type = columnTypeClause(spec, sizedColumn);
    // Engines with a length hint reject VARCHAR without a length.
    const hint = engineSpec(engine).structure.lengthHint;
    if (hint && spec.kind === "length" && !first) type = `${spec.name}(${hint})`;
    const parts = [`${quoteIdent(column.name)} ${type}`];
    if (!spec.generated) {
      const fallback = defaultClause(column.defaultValue);
      if (fallback) parts.push(fallback);
    }
    if (column.primaryKey || column.required) parts.push("not null");
    if (column.unique && !column.primaryKey) parts.push("unique");
    return parts.join(" ");
  });
  if (keys.length > 0) lines.push(`primary key (${keys.join(", ")})`);
  for (const column of usable) {
    if (!column.reference) continue;
    lines.push(foreignKeyClause({
      columns: [column.name],
      refSchema: column.reference.schema,
      refTable: column.reference.table,
      refColumns: [column.reference.column],
      onDelete: column.reference.onDelete as FkAction,
      onUpdate: "NO ACTION",
    }));
  }
  const qualified = schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
  return `create table ${qualified} (\n  ${lines.join(",\n  ")}\n)`;
}

export function insertSql(
  engine: DatabaseEngine,
  table: TableSchema,
  fields: Record<string, CellField>,
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  const names: string[] = [];
  const values: string[] = [];
  for (const column of table.columns) {
    const field = fields[column.name] ?? { text: "", isNull: true };
    const value = cellValue(column, field);
    if (value.t === "null") {
      if (column.nullable || column.defaultValue) continue;
      throw new Error(t("changes.required", { name: column.name }));
    }
    names.push(quoteIdent(column.name));
    values.push(bind(engine, params, value, column));
  }
  if (names.length === 0) {
    const empty = engineSpec(engine).sql.emptyInsert;
    return { sql: `insert into ${qualifiedName(table)} ${empty}`, params };
  }
  return {
    sql: `insert into ${qualifiedName(table)} (${names.join(", ")}) values (${values.join(", ")})`,
    params,
  };
}

export function updateSql(
  engine: DatabaseEngine,
  table: TableSchema,
  original: Record<string, SqlValue>,
  fields: Record<string, CellField>,
): { sql: string; params: SqlValue[] } {
  const keys = primaryKeys(table);
  if (keys.length === 0) throw new Error(t("changes.noPrimaryKey"));
  const params: SqlValue[] = [];
  const sets: string[] = [];
  for (const column of table.columns) {
    const field = fields[column.name];
    if (!field) continue;
    const next = cellValue(column, field);
    if (next.t === "null" && !column.nullable) throw new Error(t("changes.notNull", { name: column.name }));
    if (valuesEqual(original[column.name], next)) continue;
    sets.push(`${quoteIdent(column.name)} = ${bind(engine, params, next, column)}`);
  }
  if (sets.length === 0) throw new CodedError("no-changes", t("error.noChanges"));
  const where = keys.map((column) => {
    const current = original[column.name] ?? { t: "null" };
    if (current.t === "null") throw new Error(t("changes.nullKeySave", { name: column.name }));
    return `${quoteIdent(column.name)} = ${bind(engine, params, current, column)}`;
  });
  return {
    sql: `update ${qualifiedName(table)} set ${sets.join(", ")} where ${where.join(" and ")}`,
    params,
  };
}

export function deleteSql(engine: DatabaseEngine, table: TableSchema, original: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const keys = primaryKeys(table);
  if (keys.length === 0) throw new Error(t("changes.noPrimaryKey"));
  const params: SqlValue[] = [];
  const where = keys.map((column) => {
    const current = original[column.name] ?? { t: "null" };
    if (current.t === "null") throw new Error(t("changes.nullKeyDelete", { name: column.name }));
    return `${quoteIdent(column.name)} = ${bind(engine, params, current, column)}`;
  });
  return { sql: `delete from ${qualifiedName(table)} where ${where.join(" and ")}`, params };
}

export function rowRecord(columns: ColumnDefinition[], row: SqlValue[]): Record<string, SqlValue> {
  const record: Record<string, SqlValue> = {};
  columns.forEach((column, index) => {
    record[column.name] = row[index] ?? { t: "null" };
  });
  return record;
}

export function isGeneratedColumn(column: ColumnDefinition): boolean {
  const type = column.dataType.toLowerCase();
  if (type === "serial" || type === "bigserial" || type === "smallserial") return true;
  const fallback = (column.defaultValue ?? "").trim().toLowerCase();
  if (fallback === "auto_increment") return true;
  if (/(?:nextval|gen_random_uuid|uuid_generate_[a-z0-9_]+|clock_timestamp|statement_timestamp)\s*\(|\bnow\s*\(|\bcurrent_timestamp\b|\bcurrent_date\b/.test(fallback)) {
    return true;
  }
  return column.primaryKey && (fallback !== "" || type.includes("uuid"));
}

export function primaryKeys(table: TableSchema): ColumnDefinition[] {
  return table.columns.filter((column) => column.primaryKey);
}

/** A call ready to fill in: one value per argument, labelled with its name and type. */
export function routineCallSql(routine: TableSchema, engine: DatabaseEngine): string {
  const outputs = (mode: string | null | undefined) => mode === "OUT" || mode === "INOUT";
  // A PostgreSQL function takes only its inputs; OUT parameters come back as the result.
  const passed = routine.columns.filter((column) => !(routine.kind === "function" && column.mode === "OUT"));
  const last = passed.length - 1;
  const args = passed.map((column, index) => {
    // Some engines hand OUT and INOUT values back through session variables.
    const value = engineSpec(engine).sql.outParamVariables && outputs(column.mode) ? `@${/^\w+$/.test(column.name) ? column.name : quoteIdent(column.name)}` : (column.defaultValue ?? "NULL");
    const mode = column.mode && column.mode !== "IN" ? ` ${column.mode}` : "";
    return `  ${value}${index < last ? "," : ""} -- ${column.name} ${column.dataType}${mode}`;
  });
  const call = `${qualifiedName(routine)}(${args.length > 0 ? `\n${args.join("\n")}\n` : ""})`;
  if (routine.kind === "procedure") return `CALL ${call};`;
  // Set-returning functions read like a table.
  return /^(setof|table)\b/i.test(routine.returns ?? "") ? `SELECT * FROM ${call};` : `SELECT ${call};`;
}

export function canEditRows(table: TableSchema, readOnly: boolean): boolean {
  return !readOnly && table.kind === "table" && primaryKeys(table).length > 0;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error(t("changes.nameRequired"));
  if (name.length > 63) throw new Error(t("changes.nameTooLong"));
  return name;
}

function requireType(value: string, engine: DatabaseEngine): string {
  const type = columnTypes(engine).find((item) => item === value);
  if (!type) throw new Error(t("changes.pickType"));
  return type;
}

function columnTypeClause(spec: ColumnTypeSpec, column: AddedColumn): string {
  if (spec.kind === "length") {
    const length = optionalInt(column.length, 1, 10485760, t("changes.length"));
    return length === null ? spec.name : `${spec.name}(${length})`;
  }
  if (spec.kind === "numeric") {
    const precision = optionalInt(column.precision, 1, 1000, t("changes.precision"));
    if (precision === null) {
      if (column.scale.trim()) throw new Error(t("changes.scaleNeedsPrecision"));
      return spec.name;
    }
    const scale = optionalInt(column.scale, 0, precision, t("changes.scale"));
    return scale === null ? `${spec.name}(${precision})` : `${spec.name}(${precision},${scale})`;
  }
  return spec.name;
}

function optionalInt(value: string, min: number, max: number, label: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error(t("changes.notANumber", { label }));
  const parsed = Number(text);
  if (parsed < min || parsed > max) throw new Error(t("changes.outOfRange", { label, min, max }));
  return parsed;
}

function defaultClause(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return `default ${defaultLiteral(text)}`;
}

const defaultKeywords = new Set([
  "true", "false", "null", "current_timestamp", "current_date", "current_time",
  "localtimestamp", "localtime", "current_user", "session_user",
]);

/** A default as SQL: numbers, keywords, function calls, and quoted or cast literals stay as typed; other text is quoted. */
function defaultLiteral(text: string): string {
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  const folded = text.toLowerCase();
  if (defaultKeywords.has(folded)) return folded;
  if (/^'(?:[^']|'')*'(::[\w ."]+)?$/.test(text)) return text;
  if (/^[A-Za-z_][\w.]*\(.*\)(::[\w ."]+)?$/s.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

function isUntouchedDraft(row: ColumnDraft, engine: DatabaseEngine): boolean {
  const dataType = columnTypes(engine)[0] ?? "text";
  return row.name.trim() === ""
    && row.defaultValue.trim() === ""
    && row.nullable
    && !row.dropped
    && row.dataType === dataType
    && row.length.trim() === ""
    && row.precision.trim() === ""
    && row.scale.trim() === "";
}

function addedFrom(row: ColumnDraft): AddedColumn {
  return {
    name: row.name,
    dataType: row.dataType,
    length: row.length,
    precision: row.precision,
    scale: row.scale,
    nullable: row.nullable,
    unique: false,
    defaultValue: row.defaultValue,
  };
}

function draftTypeClause(row: ColumnDraft, engine: DatabaseEngine): string {
  const spec = columnTypeSpecs(engine).find((item) => item.name === row.dataType);
  if (!spec) throw new Error(t("changes.typeNotEditable", { type: row.dataType }));
  return columnTypeClause(spec, addedFrom(row));
}

function cellValue(column: ColumnDefinition, field: CellField): SqlValue {
  if (field.isNull) return { t: "null" };
  if (field.text.trim() === "" && !isTextual(column)) return { t: "null" };
  return encodeCell(column, field.text);
}

function isTextual(column: ColumnDefinition): boolean {
  const type = column.dataType.toLowerCase();
  return type === "text" || type.includes("char") || type === "string" || type === "citext";
}

/** Arrays arrive and are saved as their text form ({1,2}), whatever the element type. */
function isArrayType(dataType: string): boolean {
  return /\[\d*\]$/.test(dataType.trim()) || dataType.trim().toUpperCase() === "ARRAY";
}

/** Lower case, without a precision like (3), so `time(3) without time zone` reads as a time. */
function plainType(column: ColumnDefinition): string {
  return column.dataType.toLowerCase().replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, "").replace(/\s+/g, " ").trim();
}

function encodeCell(column: ColumnDefinition, raw: string): SqlValue {
  const text = raw.trim();
  const type = column.dataType.toLowerCase();
  if (isArrayType(type)) return { t: "text", v: raw };
  const marker = canonicalTemporal(text);
  if (marker === "default" && (isTemporalColumn(column) || columnOptions(column).length > 0 || isBooleanColumn(column))) {
    return { t: "text", v: "default" };
  }
  if (marker && isTemporalColumn(column)) return { t: "text", v: marker };
  if (type.includes("bool")) return { t: "bool", v: text === "true" || text === "1" || text === "t" };
  if (isInteger(type)) {
    const integer = asInt(text);
    if (integer) return { t: "int", v: integer };
  }
  if (isPlainFloat(type) && text !== "" && Number.isFinite(Number(text))) return { t: "float", v: Number(text) };
  return { t: "text", v: raw };
}

export function isTemporalColumn(column: ColumnDefinition): boolean {
  return temporalKind(column) !== null;
}

export function isBooleanColumn(column: ColumnDefinition): boolean {
  const type = column.dataType.toLowerCase();
  return type === "bool" || type === "boolean";
}

export function columnOptions(column: ColumnDefinition): string[] {
  return column.options ?? [];
}

export function temporalInputType(column: ColumnDefinition): "date" | "time" | "datetime-local" | null {
  const kind = temporalKind(column);
  if (kind === "date") return "date";
  if (kind === "time") return "time";
  if (kind === "timestamp") return "datetime-local";
  return null;
}

export function canonicalTemporal(raw: string): "now()" | "default" | "null" | null {
  const token = raw.trim().toLowerCase();
  if (token === "default") return "default";
  if (token === "null") return "null";
  if (token === "now" || token === "now()" || token === "current_timestamp" || token === "current_date" || token === "current_time" || token === "today" || token === "hoy") {
    return "now()";
  }
  return null;
}

export function temporalLabel(raw: string): string | null {
  const marker = canonicalTemporal(raw);
  if (marker === "now()") return "NOW()";
  if (marker === "default") return "DEFAULT";
  if (marker === "null") return "NULL";
  return null;
}

export function formatTemporalPick(dataType: string, raw: string): string {
  const column = { name: "", dataType, nullable: true, primaryKey: false, defaultValue: null, options: [] as string[] };
  const kind = temporalKind(column);
  if (kind === "date") return raw;
  if (kind === "time") return raw.length === 5 ? `${raw}:00` : raw;
  const [date, time] = raw.split("T");
  const clock = !time ? "00:00:00" : time.length === 5 ? `${time}:00` : time;
  if (!date) return raw;
  if (!hasTimeZone(column)) return `${date} ${clock}`;
  const parsed = new Date(`${date}T${clock}`);
  if (Number.isNaN(parsed.getTime())) return `${date} ${clock}`;
  return zoned(column, `${date}T${clock}`, `${date} ${clock}`, parsed);
}

function temporalKind(column: ColumnDefinition): "date" | "time" | "timestamp" | null {
  if (isArrayType(column.dataType)) return null;
  const type = plainType(column);
  if (type.includes("timestamp") || type.startsWith("datetime")) return "timestamp";
  if (type === "date" || type.startsWith("date ")) return "date";
  if (type === "time" || type.startsWith("time ") || type === "timetz") return "time";
  return null;
}

function hasTimeZone(column: ColumnDefinition): boolean {
  const type = plainType(column);
  return type.includes("with time zone") || type === "timestamptz" || type === "timetz";
}

function zoned(column: ColumnDefinition, withZone: string, plain: string, date: Date): string {
  if (!hasTimeZone(column)) return plain;
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${withZone}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function bind(engine: DatabaseEngine, params: SqlValue[], value: SqlValue, column: ColumnDefinition): string {
  if (value.t === "null") return "NULL";
  const keyword = temporalKeyword(engine, column, value);
  if (keyword) return keyword;
  params.push(value);
  const token = engineSpec(engine).sql.params === "dollar" ? `$${params.length}` : "?";
  if (!engineSpec(engine).sql.paramCasts) return token;
  const cast = postgresCast(column.dataType) ?? (columnOptions(column).length > 0 ? quoteTypeName(column.dataType) : null);
  return cast ? `${token}::${cast}` : token;
}

/**
 * The cast that turns a bound value into the column's type. Text params need it
 * for every type that is not text (numeric(12,2), interval, inet, int4[], hstore…),
 * or PostgreSQL rejects the comparison or assignment.
 */
export function postgresCast(dataType: string): string | null {
  const type = dataType.trim();
  const known = postgresCasts[type.toLowerCase()];
  if (known) return known;
  if (/^(array|user-defined)$/i.test(type)) return null;
  // A type as format_type spells it: optionally schema-qualified, quoted or bare names,
  // extra words (double precision, with time zone), a (precision, scale), array brackets.
  const name = `(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
  const expression = new RegExp(`^${name}(?:\\.${name})?(?: [a-z_]+)*(?:\\(\\d+(?:, ?\\d+)?\\))?(?: [a-z_]+)*(?:\\[\\d*\\])*$`, "i");
  return expression.test(type) ? type : null;
}

function quoteTypeName(name: string): string {
  return name.split(".").map((part) => quoteIdent(part)).join(".");
}

function temporalKeyword(engine: DatabaseEngine, column: ColumnDefinition, value: SqlValue): string | null {
  if (value.t !== "text") return null;
  const marker = canonicalTemporal(value.v);
  if (marker === "default" && (isTemporalColumn(column) || columnOptions(column).length > 0 || isBooleanColumn(column))) return "DEFAULT";
  if (marker === "null" && isTemporalColumn(column)) return "NULL";
  if (!isTemporalColumn(column) || marker !== "now()") return null;
  const kind = temporalKind(column);
  const [date, time, timestamp] = engineSpec(engine).sql.now;
  if (kind === "date") return date;
  if (kind === "time") return time;
  return timestamp;
}

function valuesEqual(left: SqlValue | undefined, right: SqlValue): boolean {
  if (!left || left.t === "null") return right.t === "null";
  if (right.t === "null" || left.t !== right.t) return false;
  return left.v === right.v;
}

function isInteger(type: string): boolean {
  return ["smallint", "integer", "bigint", "int", "int2", "int4", "int8", "serial", "bigserial"].some((item) => type === item || type.startsWith(`${item} `));
}

function isPlainFloat(type: string): boolean {
  return type === "real" || type === "float" || type === "float4" || type === "float8" || type === "double precision";
}

function asInt(raw: string): string | null {
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    if (value < -9223372036854775808n || value > 9223372036854775807n) return null;
    return raw;
  } catch {
    return null;
  }
}

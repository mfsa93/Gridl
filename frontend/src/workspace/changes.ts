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
  const pick = (name: string) => names.find((item) => item.toLowerCase() === name) ?? null;
  if (engine === "postgres") {
    if (type === "serial" || type === "integer" || type === "int4") return pick("integer");
    if (type === "bigserial" || type === "bigint" || type === "int8") return pick("bigint");
    if (type === "smallserial" || type === "smallint") return pick("smallint");
    if (type === "uuid") return pick("uuid");
    if (type === "text") return pick("text");
    if (type.startsWith("character varying")) return pick("varchar");
    return null;
  }
  if (engine === "mysql") {
    if (type === "serial" || type.startsWith("bigint unsigned") || type.startsWith("bigint(20) unsigned")) return pick("bigint unsigned");
    const base = type.replace(/\(.*\)/, "").trim();
    return pick(base);
  }
  return pick(type) ?? pick("integer");
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

const postgresTypes: ColumnTypeSpec[] = [
  { name: "text", kind: "plain" },
  { name: "varchar", kind: "length" },
  { name: "char", kind: "length" },
  { name: "smallint", kind: "plain" },
  { name: "integer", kind: "plain" },
  { name: "bigint", kind: "plain" },
  { name: "serial", kind: "plain", generated: true },
  { name: "bigserial", kind: "plain", generated: true },
  { name: "boolean", kind: "plain" },
  { name: "numeric", kind: "numeric" },
  { name: "real", kind: "plain" },
  { name: "double precision", kind: "plain" },
  { name: "date", kind: "plain" },
  { name: "time", kind: "plain" },
  { name: "timestamp", kind: "plain" },
  { name: "timestamptz", kind: "plain" },
  { name: "interval", kind: "plain" },
  { name: "uuid", kind: "plain" },
  { name: "json", kind: "plain" },
  { name: "jsonb", kind: "plain" },
  { name: "bytea", kind: "plain" },
];

const sqliteTypes: ColumnTypeSpec[] = [
  { name: "TEXT", kind: "plain" },
  { name: "INTEGER", kind: "plain" },
  { name: "REAL", kind: "plain" },
  { name: "NUMERIC", kind: "plain" },
  { name: "BLOB", kind: "plain" },
];

const mysqlTypes: ColumnTypeSpec[] = [
  { name: "varchar", kind: "length" },
  { name: "char", kind: "length" },
  { name: "text", kind: "plain" },
  { name: "mediumtext", kind: "plain" },
  { name: "longtext", kind: "plain" },
  { name: "tinyint", kind: "plain" },
  { name: "smallint", kind: "plain" },
  { name: "int", kind: "plain" },
  { name: "bigint", kind: "plain" },
  { name: "bigint unsigned", kind: "plain" },
  { name: "serial", kind: "plain", generated: true },
  { name: "boolean", kind: "plain" },
  { name: "decimal", kind: "numeric" },
  { name: "float", kind: "plain" },
  { name: "double", kind: "plain" },
  { name: "date", kind: "plain" },
  { name: "time", kind: "plain" },
  { name: "datetime", kind: "plain" },
  { name: "timestamp", kind: "plain" },
  { name: "json", kind: "plain" },
  { name: "blob", kind: "plain" },
  { name: "longblob", kind: "plain" },
];

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
  if (engine === "postgres") return postgresTypes;
  if (engine === "mysql") return mysqlTypes;
  return sqliteTypes;
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
  if (!spec) throw new Error("Elige un tipo de la lista");
  const type = columnTypeClause(spec, column);
  const parts = [`alter table ${qualifiedName(table)} add column ${quoteIdent(requireName(column.name))} ${type}`];
  if (!spec.generated) {
    const fallback = defaultClause(column.defaultValue);
    if (fallback) parts.push(fallback);
    if (!column.nullable) {
      if (!fallback) throw new Error("Una columna obligatoria necesita un valor predeterminado para las filas que ya existen");
      parts.push("not null");
    }
  }
  if (column.unique) {
    if (engine === "sqlite") throw new Error("SQLite no permite marcar única una columna al agregarla");
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
    if (names.has(name)) throw new Error(`La columna ${row.name.trim()} está repetida`);
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
    if (engine === "sqlite") throw new Error("SQLite solo permite renombrar, agregar o quitar columnas");
    const current = quoteIdent(next);
    if (engine === "mysql") {
      statements.push(mysqlModifySql(qualified, current, row, typeDiff));
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

/** MySQL restates the whole column definition, so type, nullability, and default go together. */
function mysqlModifySql(qualified: string, column: string, row: ColumnDraft, typeDiff: boolean): string {
  const spec = mysqlTypes.find((item) => item.name === row.dataType);
  const type = spec ? columnTypeClause(spec, addedFrom(row)) : typeDiff ? draftTypeClause(row, "mysql") : row.dataType;
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
  if (usable.length === 0) throw new Error("Agrega al menos una columna");
  const seen = new Set<string>();
  for (const column of usable) {
    const key = column.name.toLowerCase();
    if (seen.has(key)) throw new Error(`La columna ${column.name} está repetida`);
    seen.add(key);
  }
  const keys = usable.filter((column) => column.primaryKey).map((column) => quoteIdent(column.name));
  const lines = usable.map((column) => {
    const spec = columnTypeSpecs(engine).find((item) => item.name === column.dataType);
    if (!spec) throw new Error("Elige un tipo de la lista");
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
    // MySQL rejects VARCHAR without a length.
    if (engine === "mysql" && spec.kind === "length" && !first) type = `${spec.name}(255)`;
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
      throw new Error(`${column.name} es obligatorio`);
    }
    names.push(quoteIdent(column.name));
    values.push(bind(engine, params, value, column));
  }
  if (names.length === 0) {
    const empty = engine === "mysql" ? "() values ()" : "default values";
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
  if (keys.length === 0) throw new Error("Esta tabla no tiene clave primaria");
  const params: SqlValue[] = [];
  const sets: string[] = [];
  for (const column of table.columns) {
    const field = fields[column.name];
    if (!field) continue;
    const next = cellValue(column, field);
    if (next.t === "null" && !column.nullable) throw new Error(`${column.name} no acepta NULL`);
    if (valuesEqual(original[column.name], next)) continue;
    sets.push(`${quoteIdent(column.name)} = ${bind(engine, params, next, column)}`);
  }
  if (sets.length === 0) throw new Error("No hay cambios");
  const where = keys.map((column) => {
    const current = original[column.name] ?? { t: "null" };
    if (current.t === "null") throw new Error(`La clave ${column.name} es NULL y no se puede usar para guardar`);
    return `${quoteIdent(column.name)} = ${bind(engine, params, current, column)}`;
  });
  return {
    sql: `update ${qualifiedName(table)} set ${sets.join(", ")} where ${where.join(" and ")}`,
    params,
  };
}

export function deleteSql(engine: DatabaseEngine, table: TableSchema, original: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const keys = primaryKeys(table);
  if (keys.length === 0) throw new Error("Esta tabla no tiene clave primaria");
  const params: SqlValue[] = [];
  const where = keys.map((column) => {
    const current = original[column.name] ?? { t: "null" };
    if (current.t === "null") throw new Error(`La clave ${column.name} es NULL y no se puede borrar con seguridad`);
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

export function canEditRows(table: TableSchema, readOnly: boolean): boolean {
  return !readOnly && table.kind === "table" && primaryKeys(table).length > 0;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("El nombre es obligatorio");
  if (name.length > 63) throw new Error("El nombre supera 63 caracteres");
  return name;
}

function requireType(value: string, engine: DatabaseEngine): string {
  const type = columnTypes(engine).find((item) => item === value);
  if (!type) throw new Error("Elige un tipo de la lista");
  return type;
}

function columnTypeClause(spec: ColumnTypeSpec, column: AddedColumn): string {
  if (spec.kind === "length") {
    const length = optionalInt(column.length, 1, 10485760, "La longitud");
    return length === null ? spec.name : `${spec.name}(${length})`;
  }
  if (spec.kind === "numeric") {
    const precision = optionalInt(column.precision, 1, 1000, "La precisión");
    if (precision === null) {
      if (column.scale.trim()) throw new Error("La escala necesita una precisión");
      return spec.name;
    }
    const scale = optionalInt(column.scale, 0, precision, "La escala");
    return scale === null ? `${spec.name}(${precision})` : `${spec.name}(${precision},${scale})`;
  }
  return spec.name;
}

function optionalInt(value: string, min: number, max: number, label: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error(`${label} tiene que ser un número`);
  const parsed = Number(text);
  if (parsed < min || parsed > max) throw new Error(`${label} tiene que estar entre ${min} y ${max}`);
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
  if (!spec) throw new Error(`El tipo ${row.dataType} no se puede cambiar desde aquí`);
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

function encodeCell(column: ColumnDefinition, raw: string): SqlValue {
  const text = raw.trim();
  const type = column.dataType.toLowerCase();
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
  const type = column.dataType.toLowerCase();
  if (type.includes("timestamp") || type.startsWith("datetime")) return "timestamp";
  if (type === "date" || type.startsWith("date ")) return "date";
  if (type === "time" || type.startsWith("time ") || type === "timetz") return "time";
  return null;
}

function hasTimeZone(column: ColumnDefinition): boolean {
  const type = column.dataType.toLowerCase();
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
  const token = engine === "postgres" ? `$${params.length}` : "?";
  if (engine !== "postgres") return token;
  if (columnOptions(column).length > 0) return `${token}::${quoteTypeName(column.dataType)}`;
  const cast = postgresCasts[column.dataType.toLowerCase()];
  return cast ? `${token}::${cast}` : token;
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
  if (engine === "sqlite") {
    if (kind === "date") return "date('now')";
    if (kind === "time") return "time('now')";
    return "datetime('now')";
  }
  if (kind === "date") return "current_date";
  if (kind === "time") return "current_time";
  return "now()";
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

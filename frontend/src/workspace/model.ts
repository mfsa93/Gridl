import { formatSqlValue, type ColumnDefinition, type SqlValue, type TableSchema } from "../lib/api";
import { isGeneratedColumn, canonicalTemporal, isTemporalColumn, type CellField } from "./changes";
import { type ShownError } from "../lib/errors";
import { type TableFilter, type TableSort } from "./filters";

export const sqlTabId = "sql";
export const pageSizes = [50, 100, 250, 500];

export type TableQuery = {
  filters: TableFilter[];
  sort: TableSort | null;
};

export type TablePage = {
  page: number;
  pageSize: number;
  total: number;
};

export function countValue(value: SqlValue | undefined): number {
  if (!value || value.t === "null") return 0;
  if (value.t === "int" || value.t === "text") {
    const parsed = Number(value.v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value.t === "float") return Number.isFinite(value.v) ? value.v : 0;
  return 0;
}

export type TabView = {
  columns: ColumnDefinition[];
  rowCount: number;
  status: string;
  error?: ShownError | null;
  /** Set while a query runs, so the results pane keeps its place. */
  pending?: boolean;
  /** True once the editor ran something; the results pane then stays open. */
  ran?: boolean;
  /** Set when the result stopped at a row limit and can be fetched again with more. */
  more?: { sql: string; limit: number } | null;
};

export type TableTab = {
  id: string;
  table: TableSchema;
  pinned: boolean;
};

export type PendingChanges = {
  inserts: SqlValue[][];
  removed: number[];
  edits: Record<number, SqlValue[]>;
};

/** Pending edits of a page the user left; kept with the rows they apply to. */
export type PageStash = {
  key: string;
  label: string;
  edit: PendingChanges;
  rows: SqlValue[][];
  columns: ColumnDefinition[];
};

export type UndoEntry = {
  id: string;
  before: PendingChanges | null;
};

export function clonePending(edit: PendingChanges): PendingChanges {
  return structuredClone(edit);
}

export function pendingEmpty(edit: PendingChanges): boolean {
  return edit.inserts.length === 0 && edit.removed.length === 0 && Object.keys(edit.edits ?? {}).length === 0;
}

export type WorkspaceDialog =
  | { kind: "create-schema" }
  | { kind: "rename-schema"; name: string }
  | { kind: "drop-schema"; name: string }
  | { kind: "create-table" }
  | null;

/** Identifies what a table tab shows, so stashed edits come back on the same page. */
export function viewKey(page: number, pageSize: number, query: TableQuery | undefined): string {
  const filters = (query?.filters ?? []).filter((filter) => filter.enabled).map((filter) => [filter.column, filter.op, filter.value]);
  return JSON.stringify({ page, pageSize, filters, sort: query?.sort ?? null });
}

export function viewLabel(page: number, query: TableQuery | undefined): string {
  const filtered = (query?.filters ?? []).some((filter) => filter.enabled);
  return `página ${page + 1}${filtered ? " filtrada" : ""}`;
}

export function primaryKeyList(table: TableSchema, columns: ColumnDefinition[], rows: SqlValue[][]): string {
  const indexes = columns.map((column, index) => (table.columns.find((item) => item.name === column.name)?.primaryKey ? index : -1)).filter((index) => index >= 0);
  return JSON.stringify(rows.map((row) => indexes.map((index) => row[index] ?? null)));
}

export function emptyView(status = ""): TabView {
  return { columns: [], rowCount: 0, status };
}

export function tableTabId(table: TableSchema) {
  const base = table.schema ? `${table.schema}.${table.name}` : table.name;
  if (table.kind === "function" || table.kind === "procedure") {
    const signature = table.columns.map((column) => column.dataType).join(",");
    return `${table.kind}:${base}(${signature})`;
  }
  if (table.kind === "table") return base;
  return `${table.kind}:${base}`;
}

export function showsRows(table: TableSchema) {
  return table.kind === "table" || table.kind === "view" || table.kind === "materialized";
}

export const objectGroups: { kind: TableSchema["kind"]; label: string }[] = [
  { kind: "view", label: "Vistas" },
  { kind: "materialized", label: "Vistas materializadas" },
  { kind: "function", label: "Funciones" },
  { kind: "procedure", label: "Procedimientos" },
  { kind: "sequence", label: "Secuencias" },
  { kind: "trigger", label: "Triggers" },
  { kind: "index", label: "Índices" },
];

export function schemaMap(tables: TableSchema[]): Record<string, string[]> {
  const schema: Record<string, string[]> = {};
  for (const table of tables) {
    const key = table.schema ? `${table.schema}.${table.name}` : table.name;
    schema[key] = table.columns.map((column) => column.name);
  }
  return schema;
}


export function describePending(edit: PendingChanges | undefined): string {
  if (!edit) return "";
  const parts: string[] = [];
  const changed = Object.keys(edit.edits ?? {}).length;
  if (changed === 1) parts.push("1 fila modificada");
  else if (changed > 1) parts.push(`${changed} filas modificadas`);
  if (edit.inserts.length === 1) parts.push("1 fila nueva");
  else if (edit.inserts.length > 1) parts.push(`${edit.inserts.length} filas nuevas`);
  if (edit.removed.length === 1) parts.push("1 fila por borrar");
  else if (edit.removed.length > 1) parts.push(`${edit.removed.length} filas por borrar`);
  return parts.length > 0 ? `${parts.join(", ")}. Guarda para aplicar.` : "";
}

/** Status text for a tab's pending edits, counting the ones kept on other pages. */
export function describeTabChanges(edit: PendingChanges | undefined, others: PageStash[]): string {
  const here = describePending(edit);
  if (others.length === 0) return here;
  const pages = others.length === 1 ? "1 página más" : `${others.length} páginas más`;
  const prefix = here ? here.replace(/\. Guarda para aplicar\.$/, "") + ". " : "";
  return `${prefix}También hay cambios en ${pages}. Guarda para aplicar todo.`;
}

export function pastedValue(text: string, column: ColumnDefinition): SqlValue {
  const trimmed = text.trim();
  if (trimmed === "") return { t: "null" };
  if (isTemporalColumn(column)) {
    const marker = canonicalTemporal(trimmed);
    if (marker === "null") return { t: "text", v: "null" };
    if (marker) return { t: "text", v: marker };
    return { t: "text", v: text };
  }
  if (trimmed.toUpperCase() === "NULL") return { t: "null" };
  return { t: "text", v: text };
}

export function pastedRow(columns: ColumnDefinition[], cells: readonly string[], startColumn: number): SqlValue[] {
  const origin = cells.length === columns.length ? 0 : Math.max(0, startColumn);
  return columns.map((column, index) => {
    if (isGeneratedColumn(column)) return { t: "null" };
    const offset = index - origin;
    if (offset < 0 || offset >= cells.length) return { t: "null" };
    return pastedValue(cells[offset] ?? "", column);
  });
}

export function isHeaderRow(cells: readonly string[], columns: ColumnDefinition[]): boolean {
  if (cells.length === 0 || columns.length === 0) return false;
  return cells.every((cell, index) => {
    const name = columns[index]?.name;
    return Boolean(name) && cell.trim().toLowerCase() === name.toLowerCase();
  });
}

export function mergeColumns(columns: ColumnDefinition[], table: TableSchema): ColumnDefinition[] {
  return columns.map((column) => {
    const catalog = table.columns.find((item) => item.name === column.name);
    if (!catalog) return column;
    return {
      ...column,
      nullable: catalog.nullable,
      defaultValue: catalog.defaultValue,
      options: (catalog.options ?? []).length > 0 ? catalog.options : (column.options ?? []),
      dataType: (catalog.options ?? []).length > 0 ? catalog.dataType : column.dataType,
    };
  });
}

export function structureKey(table: TableSchema): string {
  const columns = table.columns.map((column) => `${column.name}:${column.dataType}:${column.nullable}:${column.defaultValue ?? ""}:${column.primaryKey}:${(column.options ?? []).join(",")}`).join("|");
  return `${table.schema ?? ""}.${table.name}:${columns}`;
}

export function sameDisplayedRow(left: SqlValue[], right: SqlValue[]): boolean {
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const current = left[index];
    const original = right[index];
    const currentText = !current || current.t === "null" ? "" : formatSqlValue(current);
    const originalText = !original || original.t === "null" ? "" : formatSqlValue(original);
    if (currentText !== originalText) return false;
  }
  return true;
}

export function fieldsFromValues(columns: ColumnDefinition[], values: SqlValue[]): Record<string, CellField> {
  const fields: Record<string, CellField> = {};
  columns.forEach((column, index) => {
    const value = values[index];
    if (!value || value.t === "null") fields[column.name] = { text: "", isNull: true };
    else fields[column.name] = { text: formatSqlValue(value), isNull: false };
  });
  return fields;
}

export function fieldsFromDraft(table: TableSchema, columns: ColumnDefinition[], values: SqlValue[]): Record<string, CellField> {
  const fields: Record<string, CellField> = {};
  for (const column of table.columns) {
    if (isGeneratedColumn(column)) continue;
    const index = columns.findIndex((item) => item.name === column.name);
    const value = index >= 0 ? values[index] : undefined;
    if (!value || value.t === "null" || value.t === "bytes") {
      fields[column.name] = { text: "", isNull: true };
    } else if (value.t === "bool") {
      fields[column.name] = { text: value.v ? "true" : "false", isNull: false };
    } else {
      fields[column.name] = { text: value.t === "text" ? value.v : formatSqlValue(value), isNull: false };
    }
  }
  return fields;
}

export function namesFromTables(list: TableSchema[]): string[] {
  const names = new Set<string>();
  for (const table of list) {
    if (table.schema) names.add(table.schema);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function kindLabel(kind: TableSchema["kind"]) {
  return objectGroups.find((group) => group.kind === kind)?.label ?? kind;
}

import { engineSpec } from "../engines";
import { formatSqlValue, qualifiedName, type ColumnDefinition, type DatabaseEngine, type SqlValue, type TableSchema } from "../lib/api";
import { isGeneratedColumn, canonicalTemporal, isTemporalColumn, type CellField } from "./changes";
import { type ShownError } from "../lib/errors";
import type { PlanNode } from "./plan";
import { formatNumber, plural, t } from "../lib/i18n";
import { type TableFilter, type TableSort } from "./filters";
import { textLiteral } from "./export";
import { commandTag, withoutComments } from "../editor/activeSql";

export const sqlTabId = "sql";

/** SQL editor tabs: the first is `sql`, later ones `sql:2`, `sql:3`… */
export function isSqlTab(id: string): boolean {
  return id === sqlTabId || id.startsWith(`${sqlTabId}:`);
}

/** The id for a new SQL tab, numbered after the highest one open. */
export function nextSqlTabId(open: string[]): string {
  const highest = Math.max(1, ...open.map(sqlTabNumber));
  return `${sqlTabId}:${highest + 1}`;
}

export function sqlTabNumber(id: string): number {
  return id === sqlTabId ? 1 : Number(id.slice(sqlTabId.length + 1)) || 1;
}
export const pageSizes = [50, 100, 250, 500];

export type TableQuery = {
  filters: TableFilter[];
  sort: TableSort | null;
};

export type TablePage = {
  page: number;
  pageSize: number;
  /** Rows on the shown page. */
  shown: number;
  /** All rows that match; null while they are still being counted. */
  total: number | null;
  /** The total is the planner's estimate, not a count. */
  approximate?: boolean;
};

/** Status line of a table page: its range, the total once counted, and the time the page took. */
export function pageStatus(page: TablePage, filtered: boolean, durationMs: number): string {
  const from = page.shown === 0 ? 0 : page.page * page.pageSize + 1;
  const to = page.page * page.pageSize + page.shown;
  const took = durationMs > 0 ? ` · ${durationMs} ms` : "";
  if (page.total === null) {
    return `${page.shown === 0 ? t("app.status.loading") : t("app.status.rangeCounting", { from: formatNumber(from), to: formatNumber(to) })}${took}`;
  }
  if (page.total === 0 || page.shown === 0) return `${filtered ? t("app.status.noMatches") : plural("common.rows", 0)}${took}`;
  const key = page.approximate ? "app.status.rangeApprox" : "app.status.range";
  return `${t(key, { from: formatNumber(from), to: formatNumber(to), total: formatNumber(page.total) })}${took}`;
}

/** Above this many rows, a table shows the catalog's estimate instead of counting. */
export const largeTableRows = 500_000;

/** Reads the catalog's row estimate for `table`, or null when the engine keeps none. */
export function rowEstimateSql(table: TableSchema, engine: DatabaseEngine): string | null {
  const source = engineSpec(engine).tools.rowEstimate;
  if (source === "pg-class") {
    // reltuples is -1 until the table is first analyzed, and 0 for plain views.
    return `select reltuples::bigint from pg_catalog.pg_class where oid = to_regclass('${qualifiedName(table).replaceAll("'", "''")}')`;
  }
  if (source === "information-schema") {
    const hex = (text: string) => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `select table_rows from information_schema.tables where table_schema = convert(X'${hex(table.schema ?? "")}' using utf8mb4) and table_name = convert(X'${hex(table.name)}' using utf8mb4)`;
  }
  if (source === "sys-partitions") {
    // Rows of the heap or clustered index, kept current by the server.
    return `select sum(rows) from sys.partitions where object_id = object_id(${textLiteral(qualifiedName(table), engine)}) and index_id in (0, 1)`;
  }
  return null;
}

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
  /** One entry per statement when a script ran several; `shown` is the one on screen. */
  results?: ScriptResult[];
  shown?: number;
  /** The plan of the last statement, when the editor asked for one instead of running it. */
  plan?: PlanNode[];
};

/** What one statement of a script returned, kept so its result can be shown again. */
export type ScriptResult = {
  sql: string;
  columns: ColumnDefinition[];
  rows: SqlValue[][];
  rowsAffected: number;
  durationMs: number;
  error?: ShownError | null;
};

/** Short tab label for a script result: its number, verb, and what it returned. */
export function scriptResultLabel(result: ScriptResult, index: number): string {
  const verb = /^(\w+)/.exec(withoutComments(result.sql))?.[1]?.toUpperCase() ?? "SQL";
  if (result.error) return `${index + 1} · ${verb} · ${t("app.results.failed")}`;
  const returnsRows = result.columns.length > 0;
  return `${index + 1} · ${verb} · ${returnsRows ? plural("common.rows", result.rows.length) : commandTag(result.sql) && result.rowsAffected === 0 ? t("app.status.completed") : plural("app.status.rowsAffected", result.rowsAffected)}`;
}

/** What a script's statement without rows did: rows it changed, or the command it completed. */
export function scriptWriteSummary(result: ScriptResult): string {
  const command = commandTag(result.sql);
  return command && result.rowsAffected === 0 ? t("app.status.commandDone", { command }) : plural("app.status.rowsAffected", result.rowsAffected);
}

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
  | { kind: "save-query"; tab: string }
  | { kind: "rename-sql-tab"; tab: string }
  | null;

/** Identifies what a table tab shows, so stashed edits come back on the same page. */
export function viewKey(page: number, pageSize: number, query: TableQuery | undefined): string {
  const filters = (query?.filters ?? []).filter((filter) => filter.enabled).map((filter) => [filter.column, filter.op, filter.value]);
  return JSON.stringify({ page, pageSize, filters, sort: query?.sort ?? null });
}

export function viewLabel(page: number, query: TableQuery | undefined): string {
  const filtered = (query?.filters ?? []).some((filter) => filter.enabled);
  return t(filtered ? "model.pageFiltered" : "model.page", { page: page + 1 });
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
  { kind: "view", label: t("model.group.view") },
  { kind: "materialized", label: t("model.group.materialized") },
  { kind: "function", label: t("model.group.function") },
  { kind: "procedure", label: t("model.group.procedure") },
  { kind: "sequence", label: t("model.group.sequence") },
  { kind: "trigger", label: t("model.group.trigger") },
  { kind: "index", label: t("model.group.index") },
];

export function schemaMap(tables: TableSchema[]): Record<string, string[]> {
  const schema: Record<string, string[]> = {};
  for (const table of tables) {
    const key = table.schema ? `${table.schema}.${table.name}` : table.name;
    schema[key] = table.columns.map((column) => column.name);
  }
  return schema;
}


/** "2 rows changed, 1 new row", without the call to save. */
export function pendingSummary(edit: PendingChanges | undefined): string {
  if (!edit) return "";
  const parts: string[] = [];
  const changed = Object.keys(edit.edits ?? {}).length;
  if (changed > 0) parts.push(plural("model.changed", changed));
  if (edit.inserts.length > 0) parts.push(plural("model.inserted", edit.inserts.length));
  if (edit.removed.length > 0) parts.push(plural("model.removed", edit.removed.length));
  return parts.join(", ");
}

export function describePending(edit: PendingChanges | undefined): string {
  const summary = pendingSummary(edit);
  return summary ? t("model.pending", { summary }) : "";
}

/** Status text for a tab's pending edits, counting the ones kept on other pages. */
export function describeTabChanges(edit: PendingChanges | undefined, others: PageStash[]): string {
  if (others.length === 0) return describePending(edit);
  const summary = pendingSummary(edit);
  return summary ? plural("model.pendingAndOtherPages", others.length, { summary }) : plural("model.otherPages", others.length);
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
  return t(`model.kind.${kind}`);
}

/** `fresh` with the definition and result type a description leaves out, kept from `known`. */
export function keepDefinition(fresh: TableSchema, known: TableSchema | undefined): TableSchema {
  return { ...fresh, definition: fresh.definition ?? known?.definition ?? null, returns: fresh.returns ?? known?.returns ?? null };
}

/**
 * The catalog with one table read again: the table replaced (or added where
 * the catalog would list it, by name among its kind and schema), and its
 * indexes and triggers replaced by `attached`, so dropped ones disappear.
 */
export function withTable(catalog: TableSchema[], fresh: TableSchema, attached: TableSchema[]): TableSchema[] {
  const id = tableTabId(fresh);
  const hangsFromIt = (item: TableSchema) => item.parent === fresh.name && (item.schema ?? null) === (fresh.schema ?? null);
  const known = catalog.find((item) => tableTabId(item) === id);
  let next = catalog.filter((item) => !hangsFromIt(item));
  if (known) {
    next = next.map((item) => (tableTabId(item) === id ? keepDefinition(fresh, item) : item));
  } else {
    const at = next.findIndex((item) => item.kind === fresh.kind && item.schema === fresh.schema && item.name.localeCompare(fresh.name) > 0);
    next = at < 0 ? [...next, fresh] : [...next.slice(0, at), fresh, ...next.slice(at)];
  }
  return [...next, ...attached];
}

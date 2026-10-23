import { quoteIdent, type DatabaseEngine, type TableSchema } from "../lib/api";
import { t } from "../lib/i18n";
import { textLiteral } from "./export";

export type FilterOp =
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "contains"
  | "not-contains"
  | "starts"
  | "ends"
  | "in"
  | "null"
  | "not-null"
  | "sql";

export type TableFilter = {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  enabled: boolean;
};

export type TableSort = {
  column: string;
  direction: "asc" | "desc";
};

export const filterOps: { op: FilterOp; label: string }[] = [
  { op: "=", label: "=" },
  { op: "<>", label: "≠" },
  { op: "<", label: "<" },
  { op: ">", label: ">" },
  { op: "<=", label: "≤" },
  { op: ">=", label: "≥" },
  { op: "contains", label: t("filter.op.contains") },
  { op: "not-contains", label: t("filter.op.notContains") },
  { op: "starts", label: t("filter.op.starts") },
  { op: "ends", label: t("filter.op.ends") },
  { op: "in", label: t("filter.op.in") },
  { op: "null", label: t("filter.op.null") },
  { op: "not-null", label: t("filter.op.notNull") },
  { op: "sql", label: t("filter.op.sql") },
];

export function opTakesValue(op: FilterOp): boolean {
  return op !== "null" && op !== "not-null";
}

export function blankFilter(column: string): TableFilter {
  return { id: crypto.randomUUID(), column, op: "=", value: "", enabled: true };
}

function likePattern(value: string, engine: DatabaseEngine, before: boolean, after: boolean): string {
  const escaped = value.replace(/[\\%_]/g, (char) => `\\${char}`);
  return textLiteral(`${before ? "%" : ""}${escaped}${after ? "%" : ""}`, engine);
}

function likeClause(column: string, engine: DatabaseEngine, pattern: string, negate: boolean): string {
  const not = negate ? "not " : "";
  // MySQL already escapes with backslash; the others need it spelled out.
  if (engine === "postgres") return `cast(${column} as text) ${not}ilike ${pattern} escape '\\'`;
  if (engine === "sqlite") return `${column} ${not}like ${pattern} escape '\\'`;
  return `${column} ${not}like ${pattern}`;
}

function condition(filter: TableFilter, engine: DatabaseEngine): string | null {
  if (filter.op === "sql") {
    const raw = filter.value.trim();
    return raw ? `(${raw})` : null;
  }
  const column = quoteIdent(filter.column);
  switch (filter.op) {
    case "null":
      return `${column} is null`;
    case "not-null":
      return `${column} is not null`;
    case "contains":
      return likeClause(column, engine, likePattern(filter.value, engine, true, true), false);
    case "not-contains":
      return likeClause(column, engine, likePattern(filter.value, engine, true, true), true);
    case "starts":
      return likeClause(column, engine, likePattern(filter.value, engine, false, true), false);
    case "ends":
      return likeClause(column, engine, likePattern(filter.value, engine, true, false), false);
    case "in": {
      const items = filter.value.split(",").map((item) => item.trim()).filter(Boolean);
      if (items.length === 0) return null;
      return `${column} in (${items.map((item) => textLiteral(item, engine)).join(", ")})`;
    }
    default:
      // Untyped literals let the database coerce to the column type.
      return `${column} ${filter.op} ${textLiteral(filter.value, engine)}`;
  }
}

/** Builds ` where ...` from the enabled filters, or an empty string. */
export function whereClause(filters: TableFilter[], engine: DatabaseEngine): string {
  const parts = filters
    .filter((filter) => filter.enabled)
    .map((filter) => condition(filter, engine))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? ` where ${parts.join(" and ")}` : "";
}

/** Orders by the chosen column, else by the primary key so paging is stable. */
export function orderClause(table: TableSchema, sort: TableSort | null): string {
  if (sort && table.columns.some((column) => column.name === sort.column)) {
    return ` order by ${quoteIdent(sort.column)} ${sort.direction}`;
  }
  const keys = table.columns.filter((column) => column.primaryKey);
  if (keys.length === 0) return "";
  return ` order by ${keys.map((column) => quoteIdent(column.name)).join(", ")}`;
}

export function nextSort(current: TableSort | null, column: string): TableSort | null {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

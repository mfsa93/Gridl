import { engineSpec } from "../engines";
import { qualifiedName, quoteIdent, type DatabaseEngine, type SqlValue, type TableSchema } from "../lib/api";

/** How many differing rows the comparison brings back to show. */
export const compareRowLimit = 1000;

export type DiffKind = "removed" | "added" | "changed";

export type DiffRow = {
  kind: DiffKind;
  /** Primary key values, as text. */
  key: string[];
  /** Columns whose values differ: [column, value in A, value in B]. Empty for added/removed rows. */
  changes: [string, string | null, string | null][];
  /** Every compared value of the row on the side it exists, for added and removed rows. */
  values: [string, string | null][];
};

export type ComparePlan = { keys: string[]; columns: string[]; sql: string; countSql: string } | { error: "no-key" | "key-missing" | "no-columns"; missing?: string };

function text(engine: DatabaseEngine, expression: string): string {
  return `CAST(${expression} AS ${engineSpec(engine).sql.textCast})`;
}

function differs(engine: DatabaseEngine, left: string, right: string): string {
  const style = engineSpec(engine).sql.nullSafeDiffers;
  if (style === "not-null-safe-equals") return `NOT (${left} <=> ${right})`;
  if (style === "is-not") return `${left} IS NOT ${right}`;
  return `${left} IS DISTINCT FROM ${right}`;
}

/**
 * SQL that lists the rows that differ between tables A and B, matched by A's
 * primary key. Values compare as they are, so 3 equals 3.00; `asText` compares
 * their text instead, for columns whose types cannot be compared. Two LEFT
 * JOINs instead of a FULL JOIN, which MySQL lacks.
 */
export function compareSql(engine: DatabaseEngine, a: TableSchema, b: TableSchema, asText = false): ComparePlan {
  const keys = a.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (keys.length === 0) return { error: "no-key" };
  const inB = new Set(b.columns.map((column) => column.name));
  const missing = keys.find((key) => !inB.has(key));
  if (missing) return { error: "key-missing", missing };
  const columns = a.columns.map((column) => column.name).filter((name) => inB.has(name) && !keys.includes(name));
  const q = quoteIdent;
  const on = keys.map((key) => `a.${q(key)} = b.${q(key)}`).join(" AND ");
  const side = (alias: string, column: string) => (asText ? text(engine, `${alias}.${q(column)}`) : `${alias}.${q(column)}`);
  const changed = columns.map((column) => differs(engine, side("a", column), side("b", column)));
  const pick = (side: "a" | "b") => [
    ...keys.map((key, index) => `${text(engine, `${side}.${q(key)}`)} AS k${index}`),
    ...columns.flatMap((column, index) => [`${text(engine, `a.${q(column)}`)} AS a${index}`, `${text(engine, `b.${q(column)}`)} AS b${index}`]),
  ].join(", ");
  const firstKey = q(keys[0] ?? "");
  const fromA = `SELECT CASE WHEN b.${firstKey} IS NULL THEN 'removed' ELSE 'changed' END AS gridl_diff, ${pick("a")} FROM ${qualifiedName(a)} a LEFT JOIN ${qualifiedName(b)} b ON ${on} WHERE b.${firstKey} IS NULL${changed.length > 0 ? ` OR ${changed.join(" OR ")}` : ""}`;
  const fromB = `SELECT 'added' AS gridl_diff, ${pick("b")} FROM ${qualifiedName(b)} b LEFT JOIN ${qualifiedName(a)} a ON ${on} WHERE a.${firstKey} IS NULL`;
  const union = `${fromA} UNION ALL ${fromB}`;
  return {
    keys,
    columns,
    sql: `SELECT * FROM (${union}) gridl_compare LIMIT ${compareRowLimit}`,
    countSql: `SELECT gridl_diff, COUNT(*) FROM (${union}) gridl_compare GROUP BY gridl_diff`,
  };
}

const value = (cell: SqlValue | undefined): string | null => (!cell || cell.t === "null" ? null : String(cell.v));

/** Same value as shown: equal text, or the same number written differently (1 and 1.00). */
function same(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.trim() === "" || right.trim() === "") return false;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/** Reads the rows of `compareSql` into what changed. */
export function parseDiff(rows: SqlValue[][], keys: string[], columns: string[]): DiffRow[] {
  return rows.map((row) => {
    const kind = value(row[0]) as DiffKind;
    const key = keys.map((_, index) => value(row[1 + index]) ?? "NULL");
    const pairs = columns.map((column, index): [string, string | null, string | null] => [column, value(row[1 + keys.length + index * 2]), value(row[2 + keys.length + index * 2])]);
    return {
      kind,
      key,
      changes: kind === "changed" ? pairs.filter(([, left, right]) => !same(left, right)) : [],
      values: kind === "removed" ? pairs.map(([column, left]) => [column, left]) : kind === "added" ? pairs.map(([column, , right]) => [column, right]) : [],
    };
  });
}

export function parseCounts(rows: SqlValue[][]): Record<DiffKind, number> {
  const counts: Record<DiffKind, number> = { removed: 0, added: 0, changed: 0 };
  for (const row of rows) {
    const kind = value(row[0]) as DiffKind;
    if (kind in counts) counts[kind] = Number(value(row[1]) ?? 0);
  }
  return counts;
}

import type { DatabaseEngine, SqlValue } from "../lib/api";
import { t } from "../lib/i18n";

/** One step of a query plan, in the same shape for every engine. */
export type PlanNode = {
  label: string;
  detail: string;
  /** Rows the planner expects this step to produce or read. */
  rows: number | null;
  cost: number | null;
  /** Set when the step reads a whole large table. */
  fullScan: boolean;
  children: PlanNode[];
};

/** A full scan above this many rows is flagged. */
export const fullScanRows = 10_000;

/** The statement that asks the engine for its plan. Nothing is executed. */
export function explainSql(engine: DatabaseEngine, sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (engine === "postgres") return `EXPLAIN (FORMAT JSON) ${statement}`;
  if (engine === "mysql") return `EXPLAIN FORMAT=JSON ${statement}`;
  return `EXPLAIN QUERY PLAN ${statement}`;
}

const text = (value: SqlValue | undefined) => (value && value.t !== "null" ? String(value.v) : "");
const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function parsePlan(engine: DatabaseEngine, rows: SqlValue[][]): PlanNode[] {
  if (engine === "sqlite") return sqlitePlan(rows);
  const raw = text(rows[0]?.[0]);
  // The driver replaces cells over its size cap with a placeholder.
  if (/^<text \d+ bytes>$/.test(raw)) throw new Error(t("app.plan.tooLarge"));
  const parsed: unknown = JSON.parse(raw);
  return engine === "postgres" ? postgresPlan(parsed) : mysqlPlan(parsed);
}

type PgNode = Record<string, unknown> & { Plans?: PgNode[] };

function postgresPlan(parsed: unknown): PlanNode[] {
  const roots = Array.isArray(parsed) ? parsed : [];
  const walk = (node: PgNode): PlanNode => {
    const type = String(node["Node Type"] ?? "");
    const join = node["Join Type"] ? ` (${String(node["Join Type"])})` : "";
    const strategy = node.Strategy && type === "Aggregate" ? ` (${String(node.Strategy)})` : "";
    const on = node["Relation Name"] ? `${String(node["Relation Name"])}${node.Alias && node.Alias !== node["Relation Name"] ? ` ${String(node.Alias)}` : ""}` : "";
    const details = [
      on,
      node["Index Name"] ? `→ ${String(node["Index Name"])}` : "",
      ...["Index Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "Recheck Cond"].map((key) => (node[key] ? `${key}: ${String(node[key])}` : "")),
      ...["Sort Key", "Group Key"].map((key) => (Array.isArray(node[key]) ? `${key}: ${(node[key] as unknown[]).join(", ")}` : "")),
    ].filter(Boolean);
    const rows = number(node["Plan Rows"]);
    return {
      label: `${type}${join}${strategy}`,
      detail: details.join(" · "),
      rows,
      cost: number(node["Total Cost"]),
      fullScan: type === "Seq Scan" && (rows ?? 0) >= fullScanRows,
      children: (node.Plans ?? []).map(walk),
    };
  };
  return roots.flatMap((root) => (root && typeof root === "object" && "Plan" in root ? [walk((root as { Plan: PgNode }).Plan)] : []));
}

const mysqlLabels: Record<string, string> = {
  query_block: "Query",
  ordering_operation: "Sort",
  grouping_operation: "Group",
  duplicates_removal: "Distinct",
  nested_loop: "Nested loop",
  union_result: "Union",
  windowing: "Window",
  materialized_from_subquery: "Subquery",
};
/** Keys that hold numbers or settings, not further steps. */
const mysqlSkip = new Set(["cost_info", "used_columns", "possible_keys", "used_key_parts", "ref", "key", "attached_condition", "buffer_result"]);

function mysqlPlan(parsed: unknown): PlanNode[] {
  const children = (value: Record<string, unknown>): PlanNode[] =>
    Object.entries(value).flatMap(([key, child]) => {
      if (mysqlSkip.has(key)) return [];
      if (Array.isArray(child)) {
        const items = child.flatMap((item) => (item && typeof item === "object" ? children(item as Record<string, unknown>) : []));
        return key === "nested_loop" ? [{ label: mysqlLabels[key] ?? key, detail: "", rows: null, cost: null, fullScan: false, children: items }] : items;
      }
      return child && typeof child === "object" ? [step(key, child as Record<string, unknown>)] : [];
    });
  const step = (key: string, value: Record<string, unknown>): PlanNode => {
    const cost = (value.cost_info ?? {}) as Record<string, unknown>;
    if (key === "table") {
      const access = String(value.access_type ?? "");
      const rows = number(value.rows_examined_per_scan);
      const details = [
        String(value.table_name ?? ""),
        value.key ? `→ ${String(value.key)}` : "",
        value.attached_condition ? `${String(value.attached_condition)}` : "",
      ].filter(Boolean);
      return { label: access ? `${access} scan` : "Table", detail: details.join(" · "), rows, cost: number(cost.prefix_cost), fullScan: access === "ALL" && (rows ?? 0) >= fullScanRows, children: children(value) };
    }
    const notes = [value.using_filesort ? "filesort" : "", value.using_temporary_table ? "temporary table" : ""].filter(Boolean);
    return { label: mysqlLabels[key] ?? key, detail: notes.join(" · "), rows: null, cost: number(cost.query_cost), fullScan: false, children: children(value) };
  };
  return parsed && typeof parsed === "object" ? children(parsed as Record<string, unknown>) : [];
}

function sqlitePlan(rows: SqlValue[][]): PlanNode[] {
  // EXPLAIN QUERY PLAN rows: id, parent, notused, detail.
  const nodes = new Map<string, PlanNode>();
  const roots: PlanNode[] = [];
  for (const row of rows) {
    const detail = text(row[3]);
    const node: PlanNode = {
      label: detail.split(" ")[0] ?? detail,
      detail: detail.split(" ").slice(1).join(" "),
      rows: null,
      cost: null,
      // SCAN without an index reads every row; SEARCH or a covering index does not.
      fullScan: /^SCAN /.test(detail) && !/USING (COVERING )?INDEX/.test(detail),
      children: [],
    };
    nodes.set(text(row[0]), node);
    const parent = nodes.get(text(row[1]));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

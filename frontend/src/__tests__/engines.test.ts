import { afterAll, describe, expect, it } from "vitest";
import builtin from "../engines/builtin.json";
import { allEngines, engineSpec, setEngines, type EngineSpec } from "../engines";
import { quoteIdent, setDialect, type TableSchema } from "../lib/api";
import { bindParams } from "../editor/params";
import { compareSql } from "../workspace/compare";
import { sqlLiteral, textLiteral } from "../workspace/export";
import { whereClause } from "../workspace/filters";
import { rowEstimateSql } from "../workspace/model";
import { explainSql } from "../workspace/plan";

const builtins = builtin as unknown as EngineSpec[];

// An engine the app has never heard of, described only by its spec: what an
// engine module or, later, an external plugin hands over.
const duck: EngineSpec = {
  ...(builtins.find((spec) => spec.id === "sqlite") as EngineSpec),
  id: "duck",
  name: "DuckDB",
  short: "Dk",
  sql: {
    ...(builtins.find((spec) => spec.id === "sqlite") as EngineSpec).sql,
    identifierQuote: '"',
    params: "dollar",
    nullSafeDiffers: "is-distinct-from",
    contains: "ilike-text",
    booleans: "keyword",
  },
  tools: { explain: null, rowEstimate: null, backup: null, restore: false },
};

describe("engine specs", () => {
  afterAll(() => setEngines(builtins));

  it("describes every built-in engine", () => {
    expect(allEngines().map((spec) => spec.id)).toEqual(["postgres", "mysql", "sqlite"]);
    expect(engineSpec("mysql").sql.identifierQuote).toBe("`");
  });

  it("lets a new engine work from its spec alone", () => {
    setEngines([...builtins, duck]);
    const engine = "duck" as never;
    setDialect(engine);
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(sqlLiteral({ t: "bool", v: true }, engine)).toBe("TRUE");
    expect(textLiteral("a\\b", engine)).toBe("'a\\b'");
    expect(bindParams("select :x, :x", engine, { x: { t: "text", v: "1" } }).sql).toBe("select $1, $1");
    expect(whereClause([{ id: "1", column: "name", op: "contains", value: "ab", enabled: true }], engine)).toContain("ilike");
    const table: TableSchema = { schema: null, name: "t", kind: "table", columns: [{ name: "id", dataType: "int", nullable: false, primaryKey: true, defaultValue: null, options: [] }, { name: "v", dataType: "int", nullable: true, primaryKey: false, defaultValue: null, options: [] }], definition: null };
    const plan = compareSql(engine, table, { ...table, name: "u" });
    expect("sql" in plan && plan.sql).toContain('a."v" IS DISTINCT FROM b."v"');
    expect(rowEstimateSql(table, engine)).toBeNull();
    expect(explainSql(engine, "select 1")).toBe("EXPLAIN QUERY PLAN select 1");
  });
});

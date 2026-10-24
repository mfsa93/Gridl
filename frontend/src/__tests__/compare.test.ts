import { describe, expect, it } from "vitest";
import { setDialect, type ColumnDefinition, type SqlValue, type TableSchema } from "../lib/api";
import { compareSql, parseCounts, parseDiff } from "../workspace/compare";

const column = (name: string, primaryKey = false): ColumnDefinition => ({ name, dataType: "text", nullable: !primaryKey, primaryKey, defaultValue: null, options: [] });
const table = (schema: string, name: string, columns: ColumnDefinition[]): TableSchema => ({ schema, name, kind: "table", columns, definition: null });
const a = table("public", "items", [column("id", true), column("name"), column("price"), column("only_a")]);
const b = table("backup", "items", [column("id"), column("name"), column("price"), column("only_b")]);
const cell = (text: string | null): SqlValue => (text === null ? { t: "null" } : { t: "text", v: text });

describe("data compare", () => {
  it("compares shared columns by A's primary key", () => {
    setDialect("postgres");
    const plan = compareSql("postgres", a, b);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.keys).toEqual(["id"]);
    expect(plan.columns).toEqual(["name", "price"]);
    expect(plan.sql).toContain('a."price" IS DISTINCT FROM b."price"');
    const textual = compareSql("postgres", a, b, true);
    expect("sql" in textual && textual.sql).toContain('CAST(a."price" AS TEXT) IS DISTINCT FROM CAST(b."price" AS TEXT)');
    expect(plan.sql).toContain('"backup"."items" b');
  });

  it("explains why two tables cannot be compared", () => {
    setDialect("postgres");
    expect(compareSql("postgres", b, a)).toEqual({ error: "no-key" });
    expect(compareSql("postgres", a, table("x", "y", [column("name")]))).toEqual({ error: "key-missing", missing: "id" });
  });

  it("reads changed, removed and added rows", () => {
    const rows = [
      [cell("changed"), cell("1"), cell("Mesa"), cell("Mesa"), cell("10"), cell("12")],
      [cell("changed"), cell("5"), cell(null), cell("Ahora"), cell("1"), cell("1.00")],
      [cell("removed"), cell("2"), cell("Silla"), cell(null), cell("5"), cell(null)],
      [cell("added"), cell("3"), cell(null), cell("Lámpara"), cell(null), cell("8")],
    ];
    expect(parseDiff(rows, ["id"], ["name", "price"])).toEqual([
      { kind: "changed", key: ["1"], changes: [["price", "10", "12"]], values: [] },
      { kind: "changed", key: ["5"], changes: [["name", null, "Ahora"]], values: [] },
      { kind: "removed", key: ["2"], changes: [], values: [["name", "Silla"], ["price", "5"]] },
      { kind: "added", key: ["3"], changes: [], values: [["name", "Lámpara"], ["price", "8"]] },
    ]);
    expect(parseCounts([[cell("changed"), cell("4")], [cell("added"), cell("1")]])).toEqual({ removed: 0, added: 1, changed: 4 });
  });
});

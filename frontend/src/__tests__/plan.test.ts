import { describe, expect, it } from "vitest";
import type { SqlValue } from "../lib/api";
import { explainSql, parsePlan, type PlanNode } from "../workspace/plan";

// Real plans for: "select cu.name, sum(o.total) from o join cu on cu.id = o.c where o.total > 10 group by cu.name order by 2 desc limit 5"
const postgres = "[{\"Plan\": {\"Node Type\": \"Limit\", \"Parallel Aware\": false, \"Async Capable\": false, \"Startup Cost\": 1288.9, \"Total Cost\": 1288.91, \"Plan Rows\": 5, \"Plan Width\": 35, \"Plans\": [{\"Node Type\": \"Sort\", \"Parent Relationship\": \"Outer\", \"Parallel Aware\": false, \"Async Capable\": false, \"Startup Cost\": 1288.9, \"Total Cost\": 1289.15, \"Plan Rows\": 100, \"Plan Width\": 35, \"Sort Key\": [\"(sum(o.total)) DESC\"], \"Plans\": [{\"Node Type\": \"Aggregate\", \"Strategy\": \"Hashed\", \"Partial Mode\": \"Simple\", \"Parent Relationship\": \"Outer\", \"Parallel Aware\": false, \"Async Capable\": false, \"Startup Cost\": 1285.99, \"Total Cost\": 1287.24, \"Plan Rows\": 100, \"Plan Width\": 35, \"Group Key\": [\"cu.name\"], \"Planned Partitions\": 0, \"Plans\": [{\"Node Type\": \"Hash Join\", \"Parent Relationship\": \"Outer\", \"Parallel Aware\": false, \"Async Capable\": false, \"Join Type\": \"Inner\", \"Startup Cost\": 3.25, \"Total Cost\": 1036.04, \"Plan Rows\": 49990, \"Plan Width\": 9, \"Inner Unique\": true, \"Hash Cond\": \"(o.c = cu.id)\", \"Plans\": [{\"Node Type\": \"Seq Scan\", \"Parent Relationship\": \"Outer\", \"Parallel Aware\": false, \"Async Capable\": false, \"Relation Name\": \"o\", \"Alias\": \"o\", \"Startup Cost\": 0.0, \"Total Cost\": 896.0, \"Plan Rows\": 49990, \"Plan Width\": 10, \"Filter\": \"(total > '10'::numeric)\"}, {\"Node Type\": \"Hash\", \"Parent Relationship\": \"Inner\", \"Parallel Aware\": false, \"Async Capable\": false, \"Startup Cost\": 2.0, \"Total Cost\": 2.0, \"Plan Rows\": 100, \"Plan Width\": 7, \"Plans\": [{\"Node Type\": \"Seq Scan\", \"Parent Relationship\": \"Outer\", \"Parallel Aware\": false, \"Async Capable\": false, \"Relation Name\": \"cu\", \"Alias\": \"cu\", \"Startup Cost\": 0.0, \"Total Cost\": 2.0, \"Plan Rows\": 100, \"Plan Width\": 7}]}]}]}]}]}}]";
const mysql = "{\"query_block\": {\"select_id\": 1, \"cost_info\": {\"query_cost\": \"0.90\"}, \"ordering_operation\": {\"using_filesort\": true, \"grouping_operation\": {\"using_temporary_table\": true, \"using_filesort\": false, \"nested_loop\": [{\"table\": {\"table_name\": \"o\", \"access_type\": \"ALL\", \"rows_examined_per_scan\": 3, \"rows_produced_per_join\": 1, \"filtered\": \"33.33\", \"cost_info\": {\"read_cost\": \"0.45\", \"eval_cost\": \"0.10\", \"prefix_cost\": \"0.55\", \"data_read_per_join\": \"16\"}, \"used_columns\": [\"id\", \"c\", \"total\"], \"attached_condition\": \"((`gridl`.`o`.`total` > 10.00) and (`gridl`.`o`.`c` is not null))\"}}, {\"table\": {\"table_name\": \"cu\", \"access_type\": \"eq_ref\", \"possible_keys\": [\"PRIMARY\"], \"key\": \"PRIMARY\", \"used_key_parts\": [\"id\"], \"key_length\": \"4\", \"ref\": [\"gridl.o.c\"], \"rows_examined_per_scan\": 1, \"rows_produced_per_join\": 1, \"filtered\": \"100.00\", \"cost_info\": {\"read_cost\": \"0.25\", \"eval_cost\": \"0.10\", \"prefix_cost\": \"0.90\", \"data_read_per_join\": \"16\"}, \"used_columns\": [\"id\", \"name\"]}}]}}}}";
const cell = (text: string): SqlValue => ({ t: "text", v: text });
const outline = (nodes: PlanNode[], depth = 0): string[] => nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.label}${node.fullScan ? " !" : ""}`, ...outline(node.children, depth + 1)]);

describe("query plans", () => {
  it("asks each engine for its plan without running the statement", () => {
    expect(explainSql("postgres", "select 1;")).toBe("EXPLAIN (FORMAT JSON) select 1");
    expect(explainSql("mysql", "select 1")).toBe("EXPLAIN FORMAT=JSON select 1");
    expect(explainSql("sqlite", "select 1")).toBe("EXPLAIN QUERY PLAN select 1");
  });

  it("reads a PostgreSQL plan and flags the large sequential scan", () => {
    const plan = parsePlan("postgres", [[cell(postgres)]]);
    expect(outline(plan)).toEqual(["Limit", "  Sort", "    Aggregate (Hashed)", "      Hash Join (Inner)", "        Seq Scan !", "        Hash", "          Seq Scan"]);
    const scan = plan[0]?.children[0]?.children[0]?.children[0]?.children[0];
    expect(scan?.detail).toContain("o");
    expect(scan?.detail).toContain("Filter:");
    expect(scan?.rows).toBeGreaterThan(10000);
  });

  it("reads a MySQL plan into steps with their tables", () => {
    const plan = parsePlan("mysql", [[cell(mysql)]]);
    expect(outline(plan)).toEqual(["Query", "  Sort", "    Group", "      Nested loop", "        ALL scan", "        eq_ref scan"]);
    expect(plan[0]?.children[0]?.children[0]?.children[0]?.children[1]?.detail).toContain("→ PRIMARY");
  });

  it("nests SQLite plan rows under their parents", () => {
    const row = (id: number, parent: number, detail: string): SqlValue[] => [cell(String(id)), cell(String(parent)), cell("0"), cell(detail)];
    const plan = parsePlan("sqlite", [row(2, 0, "SCAN o"), row(4, 0, "SEARCH cu USING INTEGER PRIMARY KEY (rowid=?)"), row(6, 0, "CO-ROUTINE sub"), row(8, 6, "SCAN t USING COVERING INDEX ix")]);
    expect(outline(plan)).toEqual(["SCAN !", "SEARCH", "CO-ROUTINE", "  SCAN"]);
  });
});

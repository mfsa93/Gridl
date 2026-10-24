import { beforeEach, describe, expect, it } from "vitest";
import type { ColumnDefinition, TableSchema } from "../lib/api";
import { readTableState, writeTableStates } from "../workspace/tableState";

const column = (name: string): ColumnDefinition => ({ name, dataType: "text", nullable: true, primaryKey: false, defaultValue: null, options: [] });
const table: TableSchema = { schema: "public", name: "orders", kind: "table", columns: [column("id"), column("status")], definition: null };
const filter = (name: string) => ({ id: name, column: name, op: "=" as const, value: "x", enabled: true });

// The tests run without a browser: a small in-memory storage stands in for it.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      clear: () => store.clear(),
    },
  },
});

describe("table state", () => {
  beforeEach(() => store.clear());

  it("brings back filters, sort and page size", () => {
    writeTableStates("c1", { t1: { filters: [filter("status")], sort: { column: "id", direction: "desc" }, pageSize: 500 } });
    expect(readTableState("c1", "t1", table)).toEqual({ filters: [filter("status")], sort: { column: "id", direction: "desc" }, pageSize: 500 });
    expect(readTableState("c2", "t1", table)).toBeNull();
  });

  it("drops filters and sorts on columns the table no longer has", () => {
    writeTableStates("c1", { t1: { filters: [filter("gone"), filter("status")], sort: { column: "gone", direction: "asc" } } });
    expect(readTableState("c1", "t1", table)).toEqual({ filters: [filter("status")], sort: null, pageSize: undefined });
  });

  it("forgets a table once it is back to the defaults", () => {
    writeTableStates("c1", { t1: { filters: [filter("status")], sort: null } });
    writeTableStates("c1", { t1: { filters: [], sort: null, pageSize: 100 } });
    expect(readTableState("c1", "t1", table)).toBeNull();
  });
});

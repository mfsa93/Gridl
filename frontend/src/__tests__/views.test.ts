import { beforeEach, describe, expect, it } from "vitest";
import { diagnosticFor } from "../editor/diagnostics";
import { setDialect, type ColumnDefinition, type SqlValue, type TableSchema } from "../lib/api";
import { describeError, isConnectionLost } from "../lib/errors";
import { formatNumber, t } from "../lib/i18n";
import { exportRows, sqlLiteral, toTsv } from "../workspace/export";
import { nextSort, orderClause, whereClause, type TableFilter } from "../workspace/filters";
import { describeTabChanges, pageStatus, primaryKeyList, rowEstimateSql, viewKey } from "../workspace/model";

const column = (name: string, primaryKey = false): ColumnDefinition => ({ name, dataType: "text", nullable: !primaryKey, primaryKey, defaultValue: null, options: [] });
const filter = (op: TableFilter["op"], value = "", name = "name"): TableFilter => ({ id: "1", column: name, op, value, enabled: true });
const items: TableSchema = { schema: "public", name: "t", kind: "table", columns: [column("id", true), column("name")], definition: null };

beforeEach(() => setDialect("postgres"));

describe("filters and sorting", () => {
  it("quotes values as untyped literals and escapes LIKE patterns", () => {
    expect(whereClause([filter("=", "O'Brien")], "postgres")).toBe(` where "name" = 'O''Brien'`);
    expect(whereClause([filter("contains", "50%_x")], "postgres")).toBe(` where cast("name" as text) ilike '%50\\%\\_x%' escape '\\'`);
    expect(whereClause([filter("in", "1, 2,,3")], "sqlite")).toBe(` where "name" in ('1', '2', '3')`);
    expect(whereClause([{ ...filter("=", "x"), enabled: false }], "sqlite")).toBe("");
  });
  it("doubles backslashes for MySQL", () => {
    setDialect("mysql");
    expect(whereClause([filter("contains", "a\\b")], "mysql")).toBe(" where `name` like '%a\\\\\\\\b%'");
  });
  it("orders by the primary key unless a column is chosen", () => {
    expect(orderClause(items, null)).toBe(' order by "id"');
    expect(orderClause(items, { column: "name", direction: "desc" })).toBe(' order by "name" desc');
    expect(nextSort(nextSort(nextSort(null, "a"), "a"), "a")).toBeNull();
  });
});

describe("export", () => {
  const columns = [column("id"), column("name")];
  const rows: SqlValue[][] = [[{ t: "int", v: "1" }, { t: "text", v: 'a,"b"\nc' }], [{ t: "int", v: "9007199254740993" }, { t: "null" }]];
  it("writes CSV with a BOM, quoting, and empty NULLs", () => {
    expect(exportRows("csv", columns, rows, "postgres", '"t"')).toBe('﻿id,name\r\n1,"a,""b""\nc"\r\n9007199254740993,\r\n');
  });
  it("keeps big integers exact in JSON", () => {
    expect(JSON.parse(exportRows("json", columns, rows, "postgres", '"t"'))[1]).toEqual({ id: "9007199254740993", name: null });
  });
  it("writes engine-specific SQL literals", () => {
    expect(sqlLiteral({ t: "bytes", v: btoa("hi") }, "postgres")).toBe("'\\x6869'");
    expect(sqlLiteral({ t: "bytes", v: btoa("hi") }, "mysql")).toBe("X'6869'");
    expect(sqlLiteral({ t: "bool", v: true }, "sqlite")).toBe("1");
    expect(sqlLiteral({ t: "text", v: "a\\b'" }, "mysql")).toBe("'a\\\\b'''");
  });
  it("copies tab separated text without breaking lines", () => {
    expect(toTsv(columns, [[{ t: "int", v: "1" }, { t: "text", v: "x\ty\nz" }]], true)).toBe("id\tname\n1\tx y z");
  });
});

describe("errors and diagnostics", () => {
  it("strips transport prefixes and explains double quotes", () => {
    const shown = describeError('database: error returned from database: column "abc" does not exist', 'select * from t where id = "abc"', "postgres");
    expect(shown.message).toBe('column "abc" does not exist');
    expect(shown.hint).toMatch(/comillas simples/);
  });
  it("recognizes dropped connections", () => {
    expect(isConnectionLost("pool timed out while waiting for an open connection")).toBe(true);
    expect(isConnectionLost("syntax error at or near")).toBe(false);
  });
  it("underlines the token at the server's position", () => {
    const range = { from: 10, to: 40, text: 'select * from t where a="x"' };
    const diagnostic = diagnosticFor(range, { checked: true, problem: { message: 'column "x" does not exist', position: range.text.indexOf('"') + 1, code: "42703" } }, "postgres");
    expect(diagnostic && range.text.slice(diagnostic.from - 10, diagnostic.to - 10)).toBe('"x"');
  });
});

describe("pending edits across pages", () => {
  it("keys a view by page, size, enabled filters and sort", () => {
    const base = viewKey(0, 100, { filters: [filter("=", "a")], sort: null });
    expect(viewKey(0, 100, { filters: [{ ...filter("=", "a"), id: "other" }], sort: null })).toBe(base);
    expect(viewKey(1, 100, { filters: [filter("=", "a")], sort: null })).not.toBe(base);
    expect(viewKey(0, 100, { filters: [{ ...filter("=", "a"), enabled: false }], sort: null })).toBe(viewKey(0, 100, undefined));
  });
  it("compares pages by primary key values only", () => {
    const columns = [column("id", true), column("name")];
    const a = primaryKeyList(items, columns, [[{ t: "int", v: "1" }, { t: "text", v: "x" }]]);
    const b = primaryKeyList(items, columns, [[{ t: "int", v: "1" }, { t: "text", v: "changed" }]]);
    expect(a).toBe(b);
  });
  it("mentions edits kept on other pages", () => {
    const stash = { key: "k", label: "página 2", edit: { inserts: [], removed: [1], edits: {} }, rows: [], columns: [] };
    expect(describeTabChanges(undefined, [stash])).toBe("También hay cambios en 1 página más. Guarda para aplicar todo.");
  });
});

describe("table pages", () => {
  const page = { page: 1, pageSize: 100, shown: 100 };
  const numbers = { from: formatNumber(101), to: formatNumber(200) };

  it("shows the range at once and the total when it is known", () => {
    expect(pageStatus({ ...page, total: null }, false, 12)).toBe(`${t("app.status.rangeCounting", numbers)} · 12 ms`);
    expect(pageStatus({ ...page, total: 5000 }, false, 12)).toBe(`${t("app.status.range", { ...numbers, total: formatNumber(5000) })} · 12 ms`);
    expect(pageStatus({ ...page, total: 5000000, approximate: true }, false, 0)).toBe(t("app.status.rangeApprox", { ...numbers, total: formatNumber(5000000) }));
    expect(pageStatus({ ...page, shown: 0, total: 0 }, true, 3)).toBe(`${t("app.status.noMatches")} · 3 ms`);
  });

  it("reads the row estimate from the catalog", () => {
    expect(rowEstimateSql(items, "postgres")).toBe(`select reltuples::bigint from pg_catalog.pg_class where oid = to_regclass('"public"."t"')`);
    expect(rowEstimateSql({ ...items, schema: "shop", name: "it's" }, "mysql")).toBe(
      "select table_rows from information_schema.tables where table_schema = convert(X'73686f70' using utf8mb4) and table_name = convert(X'69742773' using utf8mb4)",
    );
    expect(rowEstimateSql(items, "sqlite")).toBeNull();
  });
});

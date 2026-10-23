import { beforeEach, describe, expect, it } from "vitest";
import { activeSql, splitStatements, statementRanges } from "../editor/activeSql";
import { setDialect, type ColumnDefinition, type TableSchema } from "../lib/api";
import { createTableSql, deleteSql, insertSql, updateSql, type NewColumn } from "../workspace/changes";
import { addForeignKeySql, dropForeignKeySql, foreignKeyClause } from "../workspace/relations";

const column = (name: string, dataType: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name, dataType, nullable: true, primaryKey: false, defaultValue: null, options: [], ...extra,
});
const table = (columns: ColumnDefinition[], schema: string | null = "public"): TableSchema => ({ schema, name: "items", kind: "table", columns, definition: null });
const newColumn = (patch: Partial<NewColumn>): NewColumn => ({ name: "", dataType: "text", size: "", defaultValue: "", primaryKey: false, required: false, unique: false, reference: null, ...patch });

beforeEach(() => setDialect("postgres"));

describe("statement splitting", () => {
  it("ignores semicolons inside quotes, comments and dollar quotes", () => {
    expect(splitStatements("select 1; select 'a;b'; -- c;\n/* x; */ select $$;$$;")).toEqual(["select 1", "select 'a;b'", "-- c;\n/* x; */ select $$;$$"]);
  });
  it("drops statements made only of comments", () => {
    expect(splitStatements("-- nada\n;")).toEqual([]);
  });
  it("keeps source offsets for each statement", () => {
    const doc = "select 1;\n\nselect 2";
    for (const range of statementRanges(doc)) expect(doc.slice(range.from, range.to)).toBe(range.text);
  });
  it("picks the statement under the cursor", () => {
    const doc = "select 1;\nselect 2;";
    expect(activeSql(doc, 12, 12)).toBe("select 2");
    expect(activeSql(doc, 2, 2)).toBe("select 1");
  });
});

describe("create table", () => {
  it("sizes, defaults, keys, uniques and references", () => {
    const sql = createTableSql("public", "orders", [
      newColumn({ name: "id", dataType: "serial", primaryKey: true }),
      newColumn({ name: "email", dataType: "varchar", size: "120", required: true, unique: true }),
      newColumn({ name: "total", dataType: "numeric", size: "10,2", defaultValue: "0" }),
      newColumn({ name: "estado", dataType: "text", defaultValue: "activo" }),
      newColumn({ name: "creado", dataType: "timestamptz", defaultValue: "now()" }),
      newColumn({ name: "cliente_id", dataType: "integer", reference: { schema: "public", table: "clientes", column: "id", onDelete: "CASCADE" } }),
    ], "postgres");
    expect(sql).toContain('"email" varchar(120) not null unique');
    expect(sql).toContain('"total" numeric(10,2) default 0');
    expect(sql).toContain(`"estado" text default 'activo'`);
    expect(sql).toContain('"creado" timestamptz default now()');
    expect(sql).toContain('primary key ("id")');
    expect(sql).toContain('foreign key ("cliente_id") references "public"."clientes" ("id") on delete cascade');
  });
  it("gives MySQL varchar a length and uses backticks", () => {
    setDialect("mysql");
    const sql = createTableSql(null, "t", [newColumn({ name: "name", dataType: "varchar" })], "mysql");
    expect(sql).toBe("create table `t` (\n  `name` varchar(255)\n)");
  });
  it("rejects repeated column names", () => {
    expect(() => createTableSql(null, "t", [newColumn({ name: "a", dataType: "TEXT" }), newColumn({ name: "A", dataType: "TEXT" })], "sqlite")).toThrow(/repetida/);
  });
});

describe("row edits", () => {
  const items = table([column("id", "integer", { primaryKey: true, nullable: false }), column("name", "text")]);
  it("updates by primary key with typed parameters", () => {
    const original = { id: { t: "int", v: "7" }, name: { t: "text", v: "a" } } as const;
    const statement = updateSql("postgres", items, original, { id: { text: "7", isNull: false }, name: { text: "b", isNull: false } });
    expect(statement.sql).toBe('update "public"."items" set "name" = $1::text where "id" = $2::integer');
    expect(statement.params).toEqual([{ t: "text", v: "b" }, { t: "int", v: "7" }]);
  });
  it("deletes by primary key", () => {
    const statement = deleteSql("sqlite", items, { id: { t: "int", v: "7" }, name: { t: "text", v: "a" } });
    expect(statement.sql).toBe('delete from "public"."items" where "id" = ?');
  });
  it("inserts default values when nothing is set, per engine", () => {
    const empty = table([column("id", "integer", { primaryKey: true, nullable: false, defaultValue: "nextval('s')" })]);
    expect(insertSql("postgres", empty, {}).sql).toBe('insert into "public"."items" default values');
    setDialect("mysql");
    expect(insertSql("mysql", empty, {}).sql).toBe("insert into `public`.`items` () values ()");
  });
});

describe("foreign keys", () => {
  it("builds add and drop statements per engine", () => {
    const orders = table([], "public");
    const key = { columns: ["cliente_id"], refSchema: "public", refTable: "clientes", refColumns: ["id"], onDelete: "SET NULL" as const, onUpdate: "NO ACTION" as const };
    expect(foreignKeyClause(key)).toBe('foreign key ("cliente_id") references "public"."clientes" ("id") on delete set null');
    expect(addForeignKeySql("postgres", orders, key)).toMatch(/^alter table "public"."items" add constraint "items_cliente_id_fkey" foreign key/);
    expect(dropForeignKeySql("postgres", orders, "k")).toBe('alter table "public"."items" drop constraint "k"');
    setDialect("mysql");
    expect(dropForeignKeySql("mysql", orders, "k")).toBe("alter table `public`.`items` drop foreign key `k`");
    expect(() => addForeignKeySql("sqlite", orders, key)).toThrow(/SQLite/);
  });
});

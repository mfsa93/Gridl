import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { qualifiedName, setDialect, type TableSchema } from "../lib/api";
import { formatSql } from "../editor/formatSql";
import { bindParams } from "../editor/params";
import { columnChangeSql, columnDrafts, createTableSql, insertSql, listSchemasSql, routineCallSql } from "../workspace/changes";
import { compareSql } from "../workspace/compare";
import { sqlLiteral, textLiteral } from "../workspace/export";
import { pageClause, whereClause } from "../workspace/filters";
import { rowEstimateSql } from "../workspace/model";

const engine = "sqlserver" as const;

const person: TableSchema = {
  schema: "dbo",
  name: "person",
  kind: "table",
  columns: [
    { name: "id", dataType: "int", nullable: false, primaryKey: true, defaultValue: "identity", options: [] },
    { name: "name", dataType: "nvarchar(50)", nullable: false, primaryKey: false, defaultValue: null, options: [] },
    { name: "score", dataType: "decimal(10,2)", nullable: false, primaryKey: false, defaultValue: "0", options: [] },
  ],
  definition: null,
};

describe("SQL Server", () => {
  beforeAll(() => setDialect(engine));
  afterAll(() => setDialect("sqlite"));

  it("writes literals the way T-SQL reads them", () => {
    expect(textLiteral("it's ñ", engine)).toBe("N'it''s ñ'");
    expect(sqlLiteral({ t: "bytes", v: "3q2+7w==" }, engine)).toBe("0xdeadbeef");
    expect(sqlLiteral({ t: "bool", v: true }, engine)).toBe("1");
    expect(qualifiedName(person)).toBe('"dbo"."person"');
  });

  it("pages with OFFSET … FETCH, which needs an ORDER BY", () => {
    expect(pageClause(engine, ' order by "id"', 100, 200)).toBe(' order by "id" offset 200 rows fetch next 100 rows only');
    expect(pageClause(engine, "", 100, 0)).toBe(" order by (select null) offset 0 rows fetch next 100 rows only");
    expect(pageClause("postgres", "", 100, 0)).toBe(" limit 100 offset 0");
  });

  it("filters, compares and estimates with its own syntax", () => {
    expect(whereClause([{ id: "1", column: "name", op: "contains", value: "a_b", enabled: true }], engine)).toBe(` where "name" like N'%a\\_b%' escape '\\'`);
    const plan = compareSql(engine, person, { ...person, name: "person_copy" });
    expect("sql" in plan && plan.sql).toContain('EXISTS (SELECT a."name" EXCEPT SELECT b."name")');
    expect("sql" in plan && plan.sql).toMatch(/order by \(select null\) offset 0 rows fetch next \d+ rows only$/);
    expect(rowEstimateSql(person, engine)).toBe(`select sum(rows) from sys.partitions where object_id = object_id(N'"dbo"."person"') and index_id in (0, 1)`);
    expect(listSchemasSql(engine)).toContain("sys.schemas");
    expect(listSchemasSql("mysql")).toBeNull();
  });

  it("binds ? placeholders that the driver numbers", () => {
    expect(bindParams("select :a, :a", engine, { a: { t: "int", v: "1" } })).toEqual({ sql: "select ?, ?", params: [{ t: "int", v: "1" }, { t: "int", v: "1" }] });
    const insert = insertSql(engine, person, { name: { text: "Ana", isNull: false }, score: { text: "", isNull: true } });
    expect(insert.sql).toBe('insert into "dbo"."person" ("name") values (?)');
  });

  it("creates tables with identity keys", () => {
    const sql = createTableSql("dbo", "t", [
      { name: "id", dataType: "int identity", size: "", defaultValue: "", primaryKey: true, required: false, unique: false, reference: null },
      { name: "name", dataType: "nvarchar", size: "", defaultValue: "", primaryKey: false, required: true, unique: true, reference: null },
    ], engine);
    expect(sql).toBe('create table "dbo"."t" (\n  "id" int identity not null,\n  "name" nvarchar(255) not null unique,\n  primary key ("id")\n)');
  });

  it("alters columns around their default constraint", () => {
    const drafts = columnDrafts(person, engine);
    const name = drafts.find((row) => row.name === "name");
    const score = drafts.find((row) => row.name === "score");
    if (!name || !score) throw new Error("drafts");
    name.name = "full name";
    name.length = "80";
    score.nullable = true;
    score.defaultValue = "1.5";
    const added = { ...drafts[0], key: "new", originalName: null, name: "note", dataType: "nvarchar(max)", length: "", defaultValue: "", nullable: true, primaryKey: false };
    const statements = columnChangeSql(person, [...drafts, added], engine);
    expect(statements[0]).toBe('alter table "dbo"."person" add "note" nvarchar(max)');
    expect(statements[1]).toBe(`exec sp_rename N'"dbo"."person"."name"', N'full name', 'COLUMN'`);
    expect(statements[2]).toBe('alter table "dbo"."person" alter column "full name" nvarchar(80) not null');
    expect(statements[3]).toContain("from sys.default_constraints");
    expect(statements[3]).toContain(`columnproperty(object_id(N'"dbo"."person"'), N'score', 'ColumnId')`);
    expect(statements[4]).toBe('alter table "dbo"."person" alter column "score" decimal(10,2) null');
    expect(statements[5]).toBe('alter table "dbo"."person" add default 1.5 for "score"');
    expect(statements).toHaveLength(6);

    const dropped = columnDrafts(person, engine).map((row) => (row.name === "score" ? { ...row, dropped: true } : row));
    const [drop] = columnChangeSql(person, dropped, engine);
    expect(drop).toMatch(/if @gridl_default is not null exec \(@gridl_sql\);\nalter table "dbo"."person" drop column "score"$/);
  });

  it("calls procedures with EXEC and reads OUTPUT arguments back", () => {
    const procedure: TableSchema = {
      schema: "dbo",
      name: "rename_person",
      kind: "procedure",
      columns: [
        { name: "@id", dataType: "int", nullable: true, primaryKey: false, defaultValue: null, options: [], mode: "IN" },
        { name: "@old", dataType: "nvarchar(50)", nullable: true, primaryKey: false, defaultValue: null, options: [], mode: "INOUT" },
      ],
      definition: null,
    };
    expect(routineCallSql(procedure, engine)).toBe('DECLARE @old nvarchar(50);\nEXEC "dbo"."rename_person"\n  @id = NULL, -- int\n  @old = @old OUTPUT -- nvarchar(50);\nSELECT @old AS "@old";');
  });

  it("formats T-SQL", () => {
    expect(formatSql("select top 5 [a b] from t", engine)).toBe("SELECT TOP 5 [a b]\nFROM t");
  });
});

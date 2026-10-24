import { describe, expect, it } from "vitest";
import { bindParams, findParams } from "../editor/params";

describe("query parameters", () => {
  it("finds :names and skips strings, comments, casts and bodies", () => {
    const sql = `select :id, ':no', "a:no", x::int, arr[1:2] -- :no
      /* :no */ from t where a = :id and b > :since and $$ :no $$ = c`;
    expect(findParams(sql, "postgres")).toEqual(["id", "since"]);
    expect(findParams("set @a := 1; select `x:no`, :value # :no", "mysql")).toEqual(["value"]);
  });

  it("binds with each engine's placeholders", () => {
    const values = { id: { t: "text" as const, v: "5" }, since: { t: "null" as const } };
    expect(bindParams("select * from t where id = :id or parent = :id and at > :since", "postgres", values)).toEqual({
      sql: "select * from t where id = $1 or parent = $1 and at > $2",
      params: [values.id, values.since],
    });
    expect(bindParams("select * from t where id = :id or parent = :id", "mysql", values)).toEqual({
      sql: "select * from t where id = ? or parent = ?",
      params: [values.id, values.id],
    });
  });

  it("leaves SQL without parameters alone", () => {
    expect(bindParams("select '10:30', now()::date", "postgres", {})).toEqual({ sql: "select '10:30', now()::date", params: [] });
  });
});

describe("gridl links", async () => {
  const { linkTarget, parseLink, shareLink } = await import("../workspace/links");
  const profile = { id: "abc", name: "Tienda prod" } as Parameters<typeof shareLink>[0];

  it("round-trips the connection, SQL and title", () => {
    const link = shareLink(profile, "select * from t where a = 'x & y' -- ñ", "Ventas");
    expect(link.startsWith("gridl://open?")).toBe(true);
    expect(parseLink(link)).toEqual({ connection: "abc", name: "Tienda prod", sql: "select * from t where a = 'x & y' -- ñ", title: "Ventas" });
  });

  it("finds the connection by id, then by name", () => {
    const other = { id: "zzz", name: "tienda PROD" } as typeof profile;
    expect(linkTarget({ connection: "abc", name: "", sql: "", title: "" }, [other, profile])).toBe(profile);
    expect(linkTarget({ connection: "nope", name: "Tienda prod", sql: "", title: "" }, [other])).toBe(other);
    expect(linkTarget({ connection: "nope", name: "nada", sql: "", title: "" }, [other])).toBeNull();
    expect(parseLink("https://example.com/open?sql=1")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { TableSchema } from "../lib/api";
import { fuzzyScore, quickMatches } from "../workspace/fuzzy";

const object = (name: string, kind: TableSchema["kind"] = "table", schema = "public"): TableSchema => ({ schema, name, kind, columns: [], definition: null });

describe("quick open", () => {
  it("matches letters in order and rejects the rest", () => {
    expect(fuzzyScore("ars", "account_role_subscription")).not.toBeNull();
    expect(fuzzyScore("rsa", "account_role_subscription")).toBeNull();
  });

  it("ranks a prefix over a substring over scattered letters", () => {
    const names = ["role_scopes", "account_role_subscription", "permission_role", "roles"].map((name) => object(name));
    expect(quickMatches(names, "role").map((item) => item.name)).toEqual(["roles", "role_scopes", "permission_role", "account_role_subscription"]);
  });

  it("prefers word starts when letters are scattered", () => {
    const names = [object("account_role_subscription"), object("articles_raw_sources")];
    expect(quickMatches(names, "ars")[0]?.name).toBe("account_role_subscription");
    expect(quickMatches(names, "arsu")[0]?.name).toBe("account_role_subscription");
  });

  it("finds by schema-qualified name and puts tables before routines", () => {
    const items = [object("totals", "function"), object("totals"), object("orders", "table", "billing")];
    expect(quickMatches(items, "totals").map((item) => item.kind)).toEqual(["table", "function"]);
    expect(quickMatches(items, "billing.ord")[0]?.name).toBe("orders");
  });
});

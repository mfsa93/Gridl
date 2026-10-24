import { describe, expect, it } from "vitest";
import { formatSql } from "../editor/formatSql";

describe("formatSql", () => {
  it("keeps a clause's only short item on the clause line", () => {
    expect(formatSql(`select * from "public"."accounts" where created_at > now() - interval '1 days' order by created_at desc limit 100`, "postgres")).toBe(
      ["SELECT *", `FROM "public"."accounts"`, "WHERE created_at > now() - interval '1 days'", "ORDER BY created_at DESC", "LIMIT 100"].join("\n"),
    );
  });

  it("leaves clauses with several items one per line", () => {
    expect(formatSql("select a.id, count(*) as total from accounts a join orders o on o.account_id = a.id where a.active and o.total > 10 group by a.id having count(*) > 2", "postgres")).toBe(
      ["SELECT", "  a.id,", "  count(*) AS total", "FROM", "  accounts a", "  JOIN orders o ON o.account_id = a.id", "WHERE", "  a.active", "  AND o.total > 10", "GROUP BY a.id", "HAVING count(*) > 2"].join("\n"),
    );
    expect(formatSql("insert into t (a, b) values (1, 'x'), (2, 'y')", "postgres")).toBe(["INSERT INTO t (a, b)", "VALUES", "  (1, 'x'),", "  (2, 'y')"].join("\n"));
  });

  it("compacts nested queries at their own depth and leaves open brackets alone", () => {
    expect(formatSql("select id from (select id from t where x = 1) s where id in (select id from u)", "postgres")).toBe(
      ["SELECT id", "FROM", "  (", "    SELECT id", "    FROM t", "    WHERE x = 1", "  ) s", "WHERE", "  id IN (", "    SELECT id", "    FROM u", "  )"].join("\n"),
    );
  });

  it("gives the same text when run again", () => {
    const once = formatSql("select * from t where a = 1 and b = 2 order by a limit 5", "mysql");
    expect(formatSql(once, "mysql")).toBe(once);
  });

  it("keeps long single items split", () => {
    const long = `select * from t where ${"a_long_column_name = 1 or ".repeat(3)}x = 2`;
    expect(formatSql(long, "postgres").split("\n")).toContain("WHERE");
  });
});

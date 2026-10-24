import { format } from "sql-formatter";
import type { DatabaseEngine } from "../lib/api";

/** Clause keywords that sql-formatter puts on a line of their own. */
const clause = /^(SELECT( DISTINCT)?|FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|SET|VALUES|INSERT INTO|DELETE FROM|RETURNING|WINDOW|PARTITION BY)$/;

/** Joined clause lines longer than this stay split. */
const compactWidth = 80;

/**
 * Formats SQL, then pulls a clause's only item up onto the clause line:
 * `SELECT *` and `LIMIT 100` instead of a keyword alone above one short line.
 * Clauses with several items keep one item per line.
 */
export function formatSql(source: string, engine: DatabaseEngine): string {
  const dialect = engine === "postgres" ? "postgresql" : engine === "mysql" ? "mysql" : "sqlite";
  const lines = format(source, { language: dialect, keywordCase: "upper", tabWidth: 2 }).split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const body = lines[index + 1];
    const after = lines[index + 2];
    const depth = indent(line);
    const single =
      clause.test(line.trim()) &&
      body !== undefined &&
      body.trim() !== "" &&
      indent(body) === depth + 2 &&
      (after === undefined || after.trim() === "" || indent(after) <= depth);
    const joined = `${line} ${body?.trim() ?? ""}`;
    if (single && joined.length <= compactWidth) {
      out.push(joined);
      index += 1;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

import { MySQL, PostgreSQL, SQLDialect, SQLite } from "@codemirror/lang-sql";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { ReactNode } from "react";
import type { DatabaseEngine } from "../lib/api";

// Routine bodies sit between $function$ quotes. Reading those as plain SQL
// colors the body instead of painting it all as one string.
const postgresBodies = SQLDialect.define({ ...PostgreSQL.spec, doubleDollarQuotedStrings: false });

/** SQL as spans with `tok-*` classes, colored by the `.sql-tokens` styles. */
export function highlightSql(sql: string, engine: DatabaseEngine): ReactNode[] {
  const dialect = engine === "postgres" ? postgresBodies : engine === "mysql" ? MySQL : SQLite;
  const out: ReactNode[] = [];
  highlightCode(
    sql,
    dialect.language.parser.parse(sql),
    classHighlighter,
    (text, classes) => out.push(classes ? <span key={out.length} className={classes}>{text}</span> : text),
    () => out.push("\n"),
  );
  return out;
}

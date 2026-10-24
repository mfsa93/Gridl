import { MySQL, PostgreSQL, SQLDialect, SQLite } from "@codemirror/lang-sql";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { useMemo, type ReactNode } from "react";
import type { DatabaseEngine } from "../lib/api";

// Routine bodies sit between $function$ quotes. Reading those as plain SQL
// colors the body instead of painting it all as one string.
const postgresBodies = SQLDialect.define({ ...PostgreSQL.spec, doubleDollarQuotedStrings: false });

/** Read-only SQL with the editor's token colors, for catalog definitions. */
export function SqlDefinition({ sql, engine }: { sql: string; engine: DatabaseEngine }) {
  const parts = useMemo(() => {
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
  }, [sql, engine]);
  return <pre className="definition-view">{parts}</pre>;
}

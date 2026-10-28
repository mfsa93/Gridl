import { engineSpec } from "../engines";
import { MSSQL, MySQL, PostgreSQL, sql, SQLite } from "@codemirror/lang-sql";
import { LanguageSupport } from "@codemirror/language";
import { parseMixed } from "@lezer/common";
import type { DatabaseEngine } from "../lib/api";

export function sqlExtension(engine: DatabaseEngine, schema: Record<string, string[]>) {
  const dialect = { postgresql: PostgreSQL, mysql: MySQL, sqlite: SQLite, transactsql: MSSQL }[engineSpec(engine).sql.dialect];
  const support = sql({ dialect, schema, upperCaseKeywords: true });
  const { parser } = dialect.language;
  /** Highlights the body of a dollar-quoted string (`DO $$ … $$`, a function body) as SQL instead of as text. */
  const bodies = parseMixed((node, input) => {
    if (node.name !== "String") return null;
    const tag = /^\$\w*\$/.exec(input.read(node.from, Math.min(node.to, node.from + 64)))?.[0];
    if (!tag || node.to - node.from < tag.length * 2) return null;
    return { parser, overlay: [{ from: node.from + tag.length, to: node.to - tag.length }] };
  });
  return new LanguageSupport(dialect.language.configure({ wrap: bodies }), support.support);
}

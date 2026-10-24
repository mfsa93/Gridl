import { engineSpec } from "../engines";
import type { DatabaseEngine, SqlValue } from "../lib/api";

type Piece = { kind: "text"; text: string } | { kind: "param"; name: string };

/**
 * Splits SQL into text and `:name` parameters. Quotes, comments, PostgreSQL
 * `$tag$` bodies, `::casts`, MySQL `:=` and array slices like `[1:2]` are text.
 */
function split(sql: string, engine: DatabaseEngine): Piece[] {
  const { backslashEscapes, hashComments, dollarQuotes } = engineSpec(engine).sql;
  const pieces: Piece[] = [];
  let text = "";
  let at = 0;
  const push = (chunk: string) => {
    text += chunk;
  };
  while (at < sql.length) {
    const char = sql[at] ?? "";
    const next = sql[at + 1] ?? "";
    // Quoted strings and identifiers.
    if (char === "'" || char === '"' || char === "`") {
      let end = at + 1;
      while (end < sql.length) {
        if (backslashEscapes && sql[end] === "\\") {
          end += 2;
          continue;
        }
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      push(sql.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    // Comments.
    if ((char === "-" && next === "-") || (hashComments && char === "#")) {
      const end = sql.indexOf("\n", at);
      const stop = end < 0 ? sql.length : end;
      push(sql.slice(at, stop));
      at = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", at + 2);
      const stop = end < 0 ? sql.length : end + 2;
      push(sql.slice(at, stop));
      at = stop;
      continue;
    }
    // PostgreSQL dollar-quoted bodies: $$ … $$ or $tag$ … $tag$.
    if (dollarQuotes && char === "$") {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(at))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, at + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        push(sql.slice(at, stop));
        at = stop;
        continue;
      }
    }
    if (char === ":") {
      const previous = sql[at - 1] ?? "";
      const name = /^[A-Za-z_]\w*/.exec(sql.slice(at + 1))?.[0];
      if (next === ":") {
        push("::");
        at += 2;
        continue;
      }
      if (name && previous !== ":" && !/[\w\]]/.test(previous) && next !== "=") {
        if (text) pieces.push({ kind: "text", text });
        text = "";
        pieces.push({ kind: "param", name });
        at += 1 + name.length;
        continue;
      }
    }
    push(char);
    at += 1;
  }
  if (text) pieces.push({ kind: "text", text });
  return pieces;
}

/** The `:name` parameters of the SQL, each once, in the order they first appear. */
export function findParams(sql: string, engine: DatabaseEngine): string[] {
  const names: string[] = [];
  for (const piece of split(sql, engine)) {
    if (piece.kind === "param" && !names.includes(piece.name)) names.push(piece.name);
  }
  return names;
}

/** The SQL with the engine's own placeholders, and the values in the order it binds them. */
export function bindParams(sql: string, engine: DatabaseEngine, values: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  const numbered = new Map<string, number>();
  let out = "";
  for (const piece of split(sql, engine)) {
    if (piece.kind === "text") {
      out += piece.text;
      continue;
    }
    const value = values[piece.name] ?? { t: "null" as const };
    if (engineSpec(engine).sql.params === "dollar") {
      // $n can be reused, so a name used twice binds once.
      let number = numbered.get(piece.name);
      if (number === undefined) {
        params.push(value);
        number = params.length;
        numbered.set(piece.name, number);
      }
      out += `$${number}`;
    } else {
      params.push(value);
      out += "?";
    }
  }
  return { sql: out, params };
}

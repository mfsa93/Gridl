import { linter, type Diagnostic } from "@codemirror/lint";
import type { DatabaseEngine, SqlCheck } from "../lib/api";
import { describeError } from "../lib/errors";
import { statementRanges, type StatementRange } from "./activeSql";
import { t } from "../lib/i18n";

export type SqlChecker = {
  /** Identifies the connection so cached results never leak across databases. */
  key: string;
  engine: DatabaseEngine;
  check: (sql: string) => Promise<SqlCheck>;
};

const maxStatements = 60;
const maxStatementLength = 100_000;
const cacheLimit = 300;

/** Results by connection and statement text, so only edited statements go to the server. */
const cache = new Map<string, SqlCheck>();

function remember(key: string, result: SqlCheck) {
  if (cache.size >= cacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);
}

/** Clears cached checks, e.g. after a statement changed the schema. */
export function forgetChecks() {
  cache.clear();
}

/** Extends `start` over the word or quoted token there, so the squiggle covers it. */
function tokenEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") {
    const close = text.indexOf(first, start + 1);
    return close === -1 ? text.length : close + 1;
  }
  const match = /^[\w$.]+/.exec(text.slice(start));
  return start + Math.max(1, match?.[0].length ?? 1);
}

/** Finds where the error points when the server gives no offset. */
function guessOffset(message: string, text: string): number | null {
  const patterns = [
    /near ['"]([^'"]{1,40})/i,
    /no such (?:column|table|function): ([\w$.]+)/i,
    /unknown column '([^']+)'/i,
    /table '(?:[^'.]+\.)?([^']+)' doesn't exist/i,
    /column "([^"]+)" does not exist/i,
    /relation "([^"]+)" does not exist/i,
  ];
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    const found = pattern.exec(message)?.[1];
    if (!found) continue;
    const needle = found.split(".").pop()?.toLowerCase() ?? found.toLowerCase();
    const index = lower.indexOf(needle);
    if (index >= 0) return index;
  }
  return null;
}

export function diagnosticFor(range: StatementRange, result: SqlCheck, engine: DatabaseEngine): Diagnostic | null {
  const problem = result.problem;
  if (!problem) return null;
  const shown = describeError(problem.message, range.text, engine);
  const offset = problem.position !== null && problem.position > 0
    ? Math.min(problem.position - 1, range.text.length - 1)
    : guessOffset(problem.message, range.text);
  let from = range.from;
  let to = range.to;
  if (offset !== null) {
    from = range.from + offset;
    to = range.from + tokenEnd(range.text, offset);
  } else {
    const newline = range.text.indexOf("\n");
    if (newline > 0) to = range.from + newline;
  }
  return {
    from,
    to: Math.max(to, from + 1),
    severity: "error",
    source: t("editor.diagnosticSource"),
    message: shown.hint ? `${shown.message}\n${shown.hint}` : shown.message,
  };
}

/**
 * Underlines statements the database rejects. Each statement is parsed on the
 * server without running, after the user pauses typing.
 */
export function sqlDiagnostics(getChecker: () => SqlChecker | null) {
  return linter(async (view) => {
    const checker = getChecker();
    if (!checker) return [];
    const ranges = statementRanges(view.state.doc.toString()).slice(0, maxStatements);
    const diagnostics: Diagnostic[] = [];
    for (const range of ranges) {
      if (range.text.length > maxStatementLength) continue;
      const key = `${checker.key}\u0000${range.text}`;
      let result = cache.get(key);
      if (!result) {
        try {
          result = await checker.check(range.text);
        } catch {
          // A lost connection or a busy server should not turn into squiggles.
          continue;
        }
        if (result.checked) remember(key, result);
      }
      const diagnostic = diagnosticFor(range, result, checker.engine);
      if (diagnostic) diagnostics.push(diagnostic);
    }
    return diagnostics;
  }, { delay: 700 });
}

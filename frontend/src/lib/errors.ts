import type { DatabaseEngine } from "./api";
import { t } from "./i18n";

/** Stable identifiers for errors the app raises itself, so behavior never depends on wording. */
export type ErrorCode = "blocked" | "needs-authorization" | "not-authorized" | "no-changes";

/** An error the app raises with a {@link ErrorCode} next to its translated message. */
export class CodedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** The code of `error`, or of the first error in its `cause` chain that has one. */
export function errorCode(error: unknown): ErrorCode | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof CodedError) return current.code;
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export type ShownError = {
  message: string;
  hint: string | null;
};

const prefixes = [/^database:\s*/i, /^error returned from database:\s*/i, /^invalid connection config:\s*/i];

/** Strips transport prefixes so the database's own words come first. */
function cleanMessage(raw: string): string {
  let message = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      const next = message.replace(prefix, "");
      if (next !== message) {
        message = next;
        changed = true;
      }
    }
  }
  return message || raw;
}

function hintFor(message: string, code: ErrorCode | null, sql: string | null, engine: DatabaseEngine): string | null {
  const missingColumn = /column "([^"]+)" does not exist/i.exec(message);
  if (missingColumn && sql && sql.includes(`"${missingColumn[1]}"`) && engine !== "mysql") {
    return t("hint.doubleQuotes", { value: missingColumn[1] });
  }
  if (code === "blocked") return t("hint.blocked");
  if (code === "not-authorized") return t("hint.notAuthorized");
  if (/current transaction is aborted/i.test(message)) {
    return t("hint.abortedTransaction");
  }
  if (/relation "[^"]+" does not exist|no such table|doesn't exist/i.test(message)) {
    return t("hint.missingTable");
  }
  if (/read-only transaction|read only|READ ONLY|1792/i.test(message)) {
    return t("hint.readOnly");
  }
  if (isConnectionLost(message)) {
    return t("hint.connectionLost");
  }
  if (/cannot insert multiple commands into a prepared statement/i.test(message)) {
    return t("hint.multipleStatements");
  }
  return null;
}

/** Errors that mean the session to the server is gone, so reconnecting can help. */
export function isConnectionLost(message: string): boolean {
  return /is not open|not connected|connection (closed|reset|refused)|broken pipe|reset by peer|unexpected eof|end of file|pool timed out|timed out while waiting|io error|server closed|terminating connection|lost connection|gone away|tunnel|channel closed/i.test(message);
}

function rawMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return t("error.unexpected");
}

/** The message and a hint for `error`: a backend string or an error the app raised. */
export function describeError(error: unknown, sql: string | null, engine: DatabaseEngine): ShownError {
  const message = cleanMessage(rawMessage(error));
  return { message, hint: hintFor(message, errorCode(error), sql, engine) };
}

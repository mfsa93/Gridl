import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CodedError } from "./errors";
import { t } from "./i18n";

export type DatabaseEngine = "sqlite" | "postgres" | "mysql";
export type TlsMode = "prefer" | "disable" | "require" | "verify-ca" | "verify-full";
export type SshAuth = "password" | "key";
export type BrowseKind = "sqlite" | "certificate" | "key";

export type TlsSettings = {
  mode: TlsMode;
  rootCert: string | null;
  clientCert: string | null;
  clientKey: string | null;
};

export type SshSettings = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  auth: SshAuth;
  privateKey: string | null;
  hostFingerprint: string | null;
  credentialAccount: string | null;
};

export type SqlValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: string }
  | { t: "float"; v: number }
  | { t: "text"; v: string }
  | { t: "bytes"; v: string };

export type ColumnDefinition = {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  options: string[];
};

export type RelationKind = "table" | "view" | "materialized" | "function" | "procedure" | "sequence" | "trigger" | "index";

export type TableSchema = {
  schema: string | null;
  name: string;
  kind: RelationKind;
  columns: ColumnDefinition[];
  definition: string | null;
};

export type Environment = "local" | "development" | "staging" | "production";
export type GuardMode = "allow" | "confirm" | "block";

export type SafetySettings = {
  environment: Environment;
  writes: GuardMode;
  schema: GuardMode;
  confirmDangerous: boolean;
  /** Seconds before a statement is cancelled; null means no limit. */
  timeoutSecs?: number | null;
};

export const defaultSafety: SafetySettings = { environment: "local", writes: "allow", schema: "allow", confirmDangerous: true, timeoutSecs: null };

/** Policy suggested when the user picks an environment; every field stays editable. */
export function suggestedSafety(environment: Environment): SafetySettings {
  if (environment === "production") return { environment, writes: "block", schema: "block", confirmDangerous: true, timeoutSecs: 30 };
  if (environment === "staging") return { environment, writes: "confirm", schema: "confirm", confirmDangerous: true, timeoutSecs: 60 };
  return { environment, writes: "allow", schema: "allow", confirmDangerous: true, timeoutSecs: null };
}

/** What the backend sends when its safety policy stops a statement. */
export type GuardInfo = {
  mode: "confirm" | "block";
  reason: string;
  dangerous: boolean;
  environment: Environment;
  sql: string;
};

export class GuardError extends CodedError {
  readonly info: GuardInfo;
  constructor(info: GuardInfo) {
    const blocked = info.mode === "block";
    super(blocked ? "blocked" : "needs-authorization", t(blocked ? "error.blocked" : "error.needsAuthorization", { reason: info.reason }));
    this.info = info;
  }
}

const guardPrefix = "gridl-guard:";

/** Turns the backend's guard refusal into a {@link GuardError}; passes other errors through. */
function rethrowGuard(error: unknown): never {
  if (typeof error === "string" && error.startsWith(guardPrefix)) {
    throw new GuardError(JSON.parse(error.slice(guardPrefix.length)) as GuardInfo);
  }
  throw error;
}

export type ConnectionConfig = {
  id: string;
  name: string;
  engine: DatabaseEngine;
  database: string;
  host: string | null;
  port: number | null;
  username: string | null;
  credentialAccount: string | null;
  group: string | null;
  readOnly: boolean;
  createIfMissing: boolean;
  tls: TlsSettings;
  ssh: SshSettings;
  safety: SafetySettings;
};

export type TestResult = {
  message: string;
  durationMs: number;
  hostFingerprint: string | null;
};

export type ConnectionCatalog = {
  groups: string[];
  profiles: ConnectionConfig[];
};

export type RowChunk = {
  queryId: string;
  index: number;
  columns: ColumnDefinition[];
  rows: SqlValue[][];
  last: boolean;
};

export type QueryResult = {
  queryId: string;
  columns: ColumnDefinition[];
  rowCount: number;
  rowsAffected: number;
  durationMs: number;
  cancelled: boolean;
  truncated: boolean;
};

export type BatchStatement = {
  sql: string;
  params: SqlValue[];
};

export type BatchResult = {
  statements: number;
  rowsAffected: number;
  durationMs: number;
};

export type ForeignKey = {
  name: string;
  schema: string | null;
  table: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  /** Empty when SQLite leaves the referenced primary key implicit. */
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
};

export type SqlProblem = {
  message: string;
  /** 1-based character offset into the statement. */
  position: number | null;
  code: string | null;
};

export type SqlCheck = {
  checked: boolean;
  problem: SqlProblem | null;
};

export type ConnectResponse = {
  config: ConnectionConfig;
  tables: TableSchema[];
};

export function formatSqlValue(value: SqlValue | undefined): string {
  if (!value || value.t === "null") return "NULL";
  if (value.t === "bool") return value.v ? "true" : "false";
  if (value.t === "bytes") return value.v;
  return String(value.v);
}

let identifierQuote = '"';

/** Picks the identifier quote for the open connection. MySQL uses backticks. */
export function setDialect(engine: DatabaseEngine) {
  identifierQuote = engine === "mysql" ? "`" : '"';
}

export function quoteIdent(value: string): string {
  const quote = identifierQuote;
  return `${quote}${value.replaceAll(quote, quote + quote)}${quote}`;
}

export function qualifiedName(table: TableSchema): string {
  const name = quoteIdent(table.name);
  return table.schema ? `${quoteIdent(table.schema)}.${name}` : name;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return t("error.unexpected");
}

export function listProfiles(): Promise<ConnectionCatalog> {
  return invoke("list_profiles");
}

export type ConnectRequest = {
  config: ConnectionConfig;
  password: string | null;
  rememberPassword: boolean;
  sshSecret: string | null;
  rememberSshSecret: boolean;
  trustSshHost: boolean;
};

export function saveConnection(request: ConnectRequest): Promise<ConnectionCatalog> {
  return invoke("save_connection", { request });
}

export function createGroup(name: string): Promise<ConnectionCatalog> {
  return invoke("create_group", { name });
}

export function deleteGroup(name: string): Promise<ConnectionCatalog> {
  return invoke("delete_group", { name });
}

export function deleteProfile(connectionId: string): Promise<ConnectionCatalog> {
  return invoke("delete_profile", { connectionId });
}

export function connect(request: ConnectRequest): Promise<ConnectResponse> {
  return invoke("connect", { request });
}

export function testConnection(request: ConnectRequest): Promise<TestResult> {
  return invoke("test_connection", { request });
}

export function disconnect(connectionId: string): Promise<void> {
  return invoke("disconnect", { connectionId });
}

export function introspect(connectionId: string): Promise<TableSchema[]> {
  return invoke("introspect", { connectionId });
}

export function cancelQuery(queryId: string): Promise<boolean> {
  return invoke("cancel_query", { queryId });
}

export async function executeQuery(
  request: {
    connectionId: string;
    queryId: string;
    sql: string;
    params: SqlValue[];
    chunkRows: number;
    authorized?: boolean;
    /** Stop after this many rows; the result comes back `truncated`. */
    maxRows?: number;
  },
  onChunk: (chunk: RowChunk) => void,
): Promise<QueryResult> {
  let finish: () => void;
  const lastChunk = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const channel = new Channel<RowChunk>((chunk) => {
    try {
      onChunk(chunk);
    } finally {
      if (chunk.last) finish();
    }
  });
  const result = await invoke<QueryResult>("execute_query", { request, onChunk: channel }).catch(rethrowGuard);
  await lastChunk;
  return result;
}

/** Applies every statement in one transaction. Nothing is committed on failure. */
export function executeBatch(connectionId: string, statements: BatchStatement[], authorized = false): Promise<BatchResult> {
  return invoke<BatchResult>("execute_batch", { request: { connectionId, statements, authorized } }).catch(rethrowGuard);
}

export function writeExport(path: string, contents: string): Promise<void> {
  return invoke("write_export", { path, contents });
}

/** Parses one statement on the server without running it. */
export function checkSql(connectionId: string, sql: string): Promise<SqlCheck> {
  return invoke("check_sql", { connectionId, sql });
}

export function listForeignKeys(connectionId: string): Promise<ForeignKey[]> {
  return invoke("foreign_keys", { connectionId });
}

/** Tells the shell whether closing the window would lose edits. */
export function setUnsaved(unsaved: boolean): Promise<void> {
  return invoke("set_unsaved", { unsaved });
}

export function quitDiscarding(): Promise<void> {
  return invoke("quit_discarding");
}

/** Listens to events sent to this window (or to every window), not those meant for other windows. */
export function listenHere<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  try {
    return getCurrentWebviewWindow().listen<T>(event, handler);
  } catch {
    return listen<T>(event, handler);
  }
}

/** Opens the connection in its own window, or focuses the window that already has it. */
export function openConnectionWindow(connectionId: string): Promise<string> {
  return invoke("open_connection_window", { connectionId });
}

/** Opens a new window on the connection list, running `command` there. */
export function openHomeWindow(command: "new-connection" | "new-group"): Promise<string> {
  return invoke("open_home_window", { command });
}

export function closeDiscarding(): Promise<void> {
  return invoke("close_discarding");
}

export type ExportResult = { rows: number; bytes: number; durationMs: number };

/** Streams a query straight to a file in Rust, without holding the rows in the UI. */
export function exportQuery(request: {
  connectionId: string;
  queryId: string;
  sql: string;
  format: "csv" | "json" | "sql";
  path: string;
  table: string;
  authorized?: boolean;
}): Promise<ExportResult> {
  return invoke<ExportResult>("export_query", { request }).catch(rethrowGuard);
}

export type CsvPreview = { delimiter: string; headers: string[]; rows: string[][]; totalRows: number | null };

export function previewCsv(path: string, delimiter: string | null): Promise<CsvPreview> {
  return invoke("preview_csv", { path, delimiter });
}

export function importCsv(request: {
  connectionId: string;
  path: string;
  delimiter: string;
  hasHeader: boolean;
  table: string;
  columns: string[];
  mapping: (number | null)[];
  nullToken: string | null;
  authorized?: boolean;
}): Promise<{ rows: number; durationMs: number }> {
  return invoke<{ rows: number; durationMs: number }>("import_csv", { request }).catch(rethrowGuard);
}

export function backupDatabase(request: { connectionId: string; path: string; password: string | null }): Promise<{ path: string; bytes: number; durationMs: number }> {
  return invoke("backup_database", { request });
}

export function restoreDatabase(request: { connectionId: string; path: string; password: string | null; authorized?: boolean }): Promise<{ durationMs: number }> {
  return invoke<{ durationMs: number }>("restore_database", { request }).catch(rethrowGuard);
}

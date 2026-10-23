import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Braces, ChevronDown, ChevronLeft, ChevronRight, Database, Eye, FastForward, Folder, Hash, ListTree, PanelLeft, Pencil, Play, Plus, Search, Table2, TerminalSquare, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { splitStatements } from "./editor/activeSql";
import { SqlEditor, type SqlEditorHandle } from "./editor/SqlEditor";
import { ResultGrid, type GridRangeActions } from "./grid/ResultGrid";
import { ConnectionHome, type HomeCommand } from "./home/ConnectionHome";
import { toConfig, type Draft } from "./home/draft";
import {
  cancelQuery,
  connect,
  createGroup,
  deleteGroup,
  deleteProfile,
  disconnect,
  errorMessage,
  checkSql,
  defaultSafety,
  executeBatch,
  GuardError,
  executeQuery,
  formatSqlValue,
  introspect,
  listForeignKeys,
  listProfiles,
  quitDiscarding,
  setUnsaved,
  qualifiedName,
  quoteIdent,
  saveConnection,
  setDialect,
  testConnection,
  writeExport,
  type BatchStatement,
  type BrowseKind,
  type ColumnDefinition,
  type ConnectionCatalog,
  type ConnectionConfig,
  type DatabaseEngine,
  type ForeignKey,
  type GuardInfo,
  type SqlValue,
  type TableSchema,
  type TestResult,
} from "./lib/api";
import {
  canEditRows,
  createSchemaSql,
  createTableSql,
  deleteSql,
  dropSchemaSql,
  insertSql,
  isGeneratedColumn,
  canonicalTemporal,
  isTemporalColumn,
  listSchemasSql,
  primaryKeys,
  renameSchemaSql,
  rowRecord,
  schemaNameFrom,
  updateSql,
  type CellField,
  type ColumnDraft,
} from "./workspace/changes";
import { describeError, type ShownError } from "./lib/errors";
import { ConfirmDialog, NameDialog, TableDialog } from "./workspace/dialogs";
import { exportRows, sqlLiteral, toTsv, type ExportFormat } from "./workspace/export";
import { nextSort, orderClause, whereClause, type TableFilter, type TableSort } from "./workspace/filters";
import { clearHistory, forgetHistory, pushHistory, readHistory, removeHistory, toggleStar, type HistoryEntry } from "./workspace/history";
import { environmentLabel } from "./lib/environments";
import { ContextMenu, ErrorPanel, GuardDialog, UnsavedDialog, ExportMenu, type MenuItem, FilterBar, FilterToggle, HistoryMenu, PreviewDialog, ResultMessage, RowDetails } from "./workspace/panels";
import { RelationsPanel } from "./workspace/RelationsPanel";
import { findTable, keyForColumn, outgoingKeys, incomingKeys, refLabel, resolvedRefColumns } from "./workspace/relations";
import { StructureEditor } from "./workspace/StructureEditor";

const emptyCatalog: ConnectionCatalog = { groups: [], profiles: [] };
const sqlTabId = "sql";
const pageSizes = [50, 100, 250, 500];
const runShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";
const saveShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";
const formatShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘I" : "Ctrl+I";
const runAllShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⇧⌘↵" : "Ctrl+Shift+↵";
const schemaChange = /^\s*(create|alter|drop|rename|comment|truncate)\b/i;

type TableQuery = {
  filters: TableFilter[];
  sort: TableSort | null;
};

type TablePage = {
  page: number;
  pageSize: number;
  total: number;
};

function countValue(value: SqlValue | undefined): number {
  if (!value || value.t === "null") return 0;
  if (value.t === "int" || value.t === "text") {
    const parsed = Number(value.v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value.t === "float") return Number.isFinite(value.v) ? value.v : 0;
  return 0;
}

type TabView = {
  columns: ColumnDefinition[];
  rowCount: number;
  status: string;
  error?: ShownError | null;
  /** Set while a query runs, so the results pane keeps its place. */
  pending?: boolean;
  /** True once the editor ran something; the results pane then stays open. */
  ran?: boolean;
};

type TableTab = {
  id: string;
  table: TableSchema;
  pinned: boolean;
};

type PendingChanges = {
  inserts: SqlValue[][];
  removed: number[];
  edits: Record<number, SqlValue[]>;
};

/** Pending edits of a page the user left; kept with the rows they apply to. */
type PageStash = {
  key: string;
  label: string;
  edit: PendingChanges;
  rows: SqlValue[][];
  columns: ColumnDefinition[];
};

type UndoEntry = {
  id: string;
  before: PendingChanges | null;
};

function clonePending(edit: PendingChanges): PendingChanges {
  return structuredClone(edit);
}

function pendingEmpty(edit: PendingChanges): boolean {
  return edit.inserts.length === 0 && edit.removed.length === 0 && Object.keys(edit.edits ?? {}).length === 0;
}

type WorkspaceDialog =
  | { kind: "create-schema" }
  | { kind: "rename-schema"; name: string }
  | { kind: "drop-schema"; name: string }
  | { kind: "create-table" }
  | null;

/** Identifies what a table tab shows, so stashed edits come back on the same page. */
function viewKey(page: number, pageSize: number, query: TableQuery | undefined): string {
  const filters = (query?.filters ?? []).filter((filter) => filter.enabled).map((filter) => [filter.column, filter.op, filter.value]);
  return JSON.stringify({ page, pageSize, filters, sort: query?.sort ?? null });
}

function viewLabel(page: number, query: TableQuery | undefined): string {
  const filtered = (query?.filters ?? []).some((filter) => filter.enabled);
  return `página ${page + 1}${filtered ? " filtrada" : ""}`;
}

function primaryKeyList(table: TableSchema, columns: ColumnDefinition[], rows: SqlValue[][]): string {
  const indexes = columns.map((column, index) => (table.columns.find((item) => item.name === column.name)?.primaryKey ? index : -1)).filter((index) => index >= 0);
  return JSON.stringify(rows.map((row) => indexes.map((index) => row[index] ?? null)));
}

function emptyView(status = ""): TabView {
  return { columns: [], rowCount: 0, status };
}

function tableTabId(table: TableSchema) {
  const base = table.schema ? `${table.schema}.${table.name}` : table.name;
  if (table.kind === "function" || table.kind === "procedure") {
    const signature = table.columns.map((column) => column.dataType).join(",");
    return `${table.kind}:${base}(${signature})`;
  }
  if (table.kind === "table") return base;
  return `${table.kind}:${base}`;
}

function showsRows(table: TableSchema) {
  return table.kind === "table" || table.kind === "view" || table.kind === "materialized";
}

const objectGroups: { kind: TableSchema["kind"]; label: string }[] = [
  { kind: "view", label: "Vistas" },
  { kind: "materialized", label: "Vistas materializadas" },
  { kind: "function", label: "Funciones" },
  { kind: "procedure", label: "Procedimientos" },
  { kind: "sequence", label: "Secuencias" },
  { kind: "trigger", label: "Triggers" },
  { kind: "index", label: "Índices" },
];

function schemaMap(tables: TableSchema[]): Record<string, string[]> {
  const schema: Record<string, string[]> = {};
  for (const table of tables) {
    const key = table.schema ? `${table.schema}.${table.name}` : table.name;
    schema[key] = table.columns.map((column) => column.name);
  }
  return schema;
}

export function App() {
  const [screen, setScreen] = useState<"home" | "workspace">("home");
  const [catalog, setCatalog] = useState<ConnectionCatalog>(emptyCatalog);
  const [active, setActive] = useState<ConnectionConfig | null>(null);
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([]);
  const [tableTabs, setTableTabs] = useState<TableTab[]>([]);
  const [paging, setPaging] = useState<Record<string, TablePage>>({});
  const [schemaChoice, setSchemaChoice] = useState("public");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dbSchemas, setDbSchemas] = useState<string[]>([]);
  const [pickedRows, setPickedRows] = useState<number[]>([]);
  const [pending, setPending] = useState<Record<string, PendingChanges>>({});
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState(sqlTabId);
  const [sqlSeed, setSqlSeed] = useState("");
  const [tablePane, setTablePane] = useState<"rows" | "structure">("rows");
  const [views, setViews] = useState<Record<string, TabView>>({
    [sqlTabId]: emptyView("Ejecuta una consulta o elige una tabla."),
  });
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filterDrafts, setFilterDrafts] = useState<Record<string, TableFilter[]>>({});
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const [tableQueries, setTableQueries] = useState<Record<string, TableQuery>>({});
  const tableQueryRef = useRef<Record<string, TableQuery>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [preview, setPreview] = useState<BatchStatement[] | null>(null);
  const [focusedRow, setFocusedRow] = useState<{ tab: string; row: number } | null>(null);
  const [detailsTab, setDetailsTab] = useState<"row" | "structure">("row");
  /** Unapplied column edits per table tab, tagged with the schema they were made against. */
  const [structureDrafts, setStructureDrafts] = useState<Record<string, { signature: string; rows: ColumnDraft[] }>>({});
  const [stashes, setStashes] = useState<Record<string, PageStash[]>>({});
  const stashRef = useRef<Record<string, PageStash[]>>({});
  const loadedPage = useRef<Record<string, { key: string; label: string; columns: ColumnDefinition[] }>>({});
  const putStashes = useCallback((next: Record<string, PageStash[]>) => {
    stashRef.current = next;
    setStashes(next);
  }, []);
  /** True after BEGIN in the editor until COMMIT or ROLLBACK; leaving rolls it back. */
  const [inTransaction, setInTransaction] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<{ items: string[]; action: string } | null>(null);
  const discardResolve = useRef<((ok: boolean) => void) | null>(null);
  const confirmDiscardRef = useRef<(scope?: { tab?: string; action?: string; currentPageOnly?: boolean }) => Promise<boolean>>(async () => true);
  const [guardAsk, setGuardAsk] = useState<{ info: GuardInfo; many: boolean } | null>(null);
  const guardResolve = useRef<((ok: boolean) => void) | null>(null);
  /** Shows the authorization sheet and resolves with the user's answer. */
  const askGuard = useCallback((info: GuardInfo, many = false) => new Promise<boolean>((resolve) => {
    guardResolve.current?.(false);
    guardResolve.current = resolve;
    setGuardAsk({ info, many });
  }), []);
  const answerGuard = (ok: boolean) => {
    guardResolve.current?.(ok);
    guardResolve.current = null;
    setGuardAsk(null);
  };
  /** Runs `run`; when the policy asks for authorization, asks the user and runs again authorized. */
  const guarded = useCallback(async <T,>(run: (authorized: boolean) => Promise<T>): Promise<T> => {
    try {
      return await run(false);
    } catch (caught) {
      if (!(caught instanceof GuardError) || caught.info.mode !== "confirm") throw caught;
      if (!(await askGuard(caught.info))) throw new Error("No se ejecutó: falta tu autorización.", { cause: caught });
      return run(true);
    }
  }, [askGuard]);
  const [cellMenu, setCellMenu] = useState<{ tab: string; row: number; column: number; x: number; y: number; range: GridRangeActions | null } | null>(null);
  const [objectQuery, setObjectQuery] = useState("");
  const [selectedTable, setSelectedTable] = useState<TableSchema | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(() => readPaneWidth("gridl.explorer", 280));
  const [detailsWidth, setDetailsWidth] = useState(() => readPaneWidth("gridl.details", 260));
  const [resultsHeight, setResultsHeight] = useState(() => readResultsHeight());
  const sqlStageRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [homeCommand, setHomeCommand] = useState<HomeCommand | null>(null);
  const commandNonce = useRef(0);
  const rowsByTab = useRef<Record<string, SqlValue[][]>>({ [sqlTabId]: [] });
  const rowHandles = useRef<Record<string, { current: SqlValue[][] }>>({});
  const editorRef = useRef<SqlEditorHandle>(null);
  const pendingLoads = useRef<TableSchema[]>([]);
  const workspaceState = useRef({ id: null as string | null, tabs: [] as TableTab[], activeTabId: sqlTabId });
  const saveEditsRef = useRef<() => void>(() => undefined);
  const closeTabRef = useRef<() => void>(() => undefined);
  const undoRef = useRef<() => void>(() => undefined);
  const refreshSchemaRef = useRef<() => void>(() => undefined);
  const resetTableQueriesRef = useRef<() => void>(() => undefined);
  const reloadRef = useRef<() => void>(() => undefined);
  const pendingRef = useRef(pending);
  const undoStack = useRef<UndoEntry[]>([]);
  const activeQuery = useRef<string | null>(null);
  const runningTab = useRef<string | null>(null);
  const writeLock = useRef(false);
  const writeError = useRef<string | null>(null);

  const rowsHandle = (id: string) => {
    const store = rowsByTab.current;
    store[id] ??= [];
    const handle = rowHandles.current[id] ?? { current: store[id] };
    handle.current = store[id];
    rowHandles.current[id] = handle;
    return handle;
  };

  const resetTableQueries = () => {
    putStashes({});
    loadedPage.current = {};
    setStructureDrafts({});
    tableQueryRef.current = {};
    setTableQueries({});
    setFilterDrafts({});
    setFilterOpen({});
    setFocusedRow(null);
    setPreview(null);
  };

  resetTableQueriesRef.current = resetTableQueries;

  const resetTabs = () => {
    resetTableQueries();
    rowsByTab.current = { [sqlTabId]: [] };
    rowHandles.current = {};
    setTableTabs([]);
    setPaging({});
    setSchemaChoice("public");
    setDbSchemas([]);
    setPickedRows([]);
    undoStack.current = [];
    pendingRef.current = {};
    setPending({});
    setDialog(null);
    setFormError(null);
    setActiveTabId(sqlTabId);
    setViews({ [sqlTabId]: emptyView("Ejecuta una consulta o elige una tabla.") });
  };
  const schema = useMemo(() => schemaMap(tables), [tables]);
  const checker = useMemo(() => {
    if (!active) return null;
    const connectionId = active.id;
    return { key: connectionId, engine: active.engine, check: (sql: string) => checkSql(connectionId, sql) };
  }, [active]);
  const engine: DatabaseEngine = active?.engine ?? "sqlite";
  const safety = active?.safety ?? defaultSafety;
  /** Row edits are off when the connection is read-only or its policy blocks writes. */
  const editLocked = Boolean(active?.readOnly) || safety.writes === "block";
  /** Structure edits are off when the connection is read-only or its policy blocks DDL. */
  const structureLocked = Boolean(active?.readOnly) || safety.schema === "block";
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });

  useEffect(() => {
    pendingRef.current = pending;
  });

  const saveWorkspace = (id: string) => {
    const state = workspaceState.current;
    writeSession(id, {
      sql: editorRef.current?.getValue() ?? readSession(id)?.sql ?? "",
      activeTab: state.activeTabId,
      tabs: workspaceTabs(state.tabs),
    });
  };

  useEffect(() => {
    let stop = () => {};
    void listen<string>("gridl-command", (event) => {
      const kind = event.payload;
      if (kind === "close-tab") {
        closeTabRef.current();
        return;
      }
      if (kind === "reload") {
        reloadRef.current();
        return;
      }
      if (kind !== "new-connection" && kind !== "new-group") return;
      void (async () => {
        if (!(await confirmDiscardRef.current({ action: "Salir de esta conexión" }))) return;
        setInTransaction(false);
        const current = activeRef.current;
        if (current) {
          saveWorkspace(current.id);
          void disconnect(current.id).catch(() => undefined);
        }
        activeQuery.current = null;
        runningTab.current = null;
        commandNonce.current += 1;
        setActive(null);
        setTables([]);
        resetTableQueriesRef.current();
        rowsByTab.current = { [sqlTabId]: [] };
        rowHandles.current = {};
        setTableTabs([]);
        setPaging({});
        setSchemaChoice("public");
        setDbSchemas([]);
        setPickedRows([]);
        undoStack.current = [];
        pendingRef.current = {};
        setPending({});
        setDialog(null);
        setFormError(null);
        setActiveTabId(sqlTabId);
        setViews({ [sqlTabId]: emptyView("Ejecuta una consulta o elige una tabla.") });
        setRunning(false);
        setScreen("home");
        setHomeCommand({ nonce: commandNonce.current, kind });
      })();
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listProfiles()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const browse = async (kind: BrowseKind) => {
    const filters = {
      sqlite: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }],
      certificate: [{ name: "Certificado", extensions: ["crt", "pem", "cer"] }],
      key: [{ name: "Llave", extensions: ["pem", "key"] }],
    }[kind];
    const selected = await open({ multiple: false, directory: false, filters });
    return typeof selected === "string" ? selected : null;
  };

  const enter = (config: ConnectionConfig, nextTables: TableSchema[]) => {
    const saved = readSession(config.id);
    const tabs = matchTabs(saved, nextTables);
    const nextTab = saved && (saved.activeTab === sqlTabId || tabs.some((tab) => tab.id === saved.activeTab)) ? saved.activeTab : sqlTabId;
    setDialect(config.engine);
    setActive(config);
    setTables(nextTables);
    setForeignKeys([]);
    void listForeignKeys(config.id).then(setForeignKeys).catch(() => undefined);
    setHistory(readHistory(config.id));
    resetTableQueries();
    setError(null);
    setObjectQuery("");
    rowsByTab.current = { [sqlTabId]: [] };
    rowHandles.current = {};
    setTableTabs(tabs);
    setPaging({});
    setSchemaChoice("public");
    setPickedRows([]);
    undoStack.current = [];
    pendingRef.current = {};
    setPending({});
    setDialog(null);
    setFormError(null);
    setActiveTabId(nextTab);
    setSelectedTable(tabs.find((tab) => tab.id === nextTab)?.table ?? null);
    setViews({ [sqlTabId]: emptyView("Ejecuta una consulta o elige una tabla.") });
    setSqlSeed(saved?.sql ?? "");
    pendingLoads.current = tabs.filter((tab) => showsRows(tab.table)).map((tab) => tab.table);
    setDbSchemas(namesFromTables(nextTables));
    if (config.engine === "postgres") void readSchemas(config.id).then(setDbSchemas).catch(() => undefined);
    setScreen("workspace");
  };

  const openSaved = async (profile: ConnectionConfig) => {
    setBusy(true);
    setError(null);
    try {
      const response = await connect({
        config: profile,
        password: null,
        rememberPassword: false,
        sshSecret: null,
        rememberSshSecret: false,
        trustSshHost: false,
      });
      setCatalog(await listProfiles());
      enter(response.config, response.tables);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async (draft: Draft, openAfter: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const request = {
        config: toConfig(draft),
        password: draft.password || null,
        rememberPassword: draft.rememberPassword,
        sshSecret: draft.sshSecret || null,
        rememberSshSecret: draft.rememberSshSecret,
        trustSshHost: draft.trustSshHost,
      };
      if (openAfter) {
        const response = await connect(request);
        setCatalog(await listProfiles());
        enter(response.config, response.tables);
      } else {
        setCatalog(await saveConnection(request));
      }
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const testDraft = async (draft: Draft): Promise<TestResult> => {
    return testConnection({
      config: toConfig(draft),
      password: draft.password || null,
      rememberPassword: false,
      sshSecret: draft.sshSecret || null,
      rememberSshSecret: false,
      trustSshHost: draft.trustSshHost,
    });
  };

  const addGroup = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      setCatalog(await createGroup(name));
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      setCatalog(await deleteGroup(name));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setCatalog(await deleteProfile(id));
      window.localStorage.removeItem(sessionKey(id));
      forgetHistory(id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const goHome = async () => {
    if (!(await confirmDiscardRef.current({ action: "Volver a Conexiones" }))) return;
    setInTransaction(false);
    if (active) saveWorkspace(active.id);
    const queryId = activeQuery.current;
    if (queryId) await cancelQuery(queryId).catch(() => undefined);
    if (active) await disconnect(active.id).catch(() => undefined);
    activeQuery.current = null;
    runningTab.current = null;
    setActive(null);
    setTables([]);
    resetTabs();
    setRunning(false);
    setScreen("home");
  };

  const refreshSchema = async () => {
    if (!active) return;
    try {
      const next = await introspect(active.id);
      setTables(next);
      void listForeignKeys(active.id).then(setForeignKeys).catch(() => undefined);
      editorRef.current?.relint();
      setTableTabs((current) => current.map((tab) => {
        const fresh = next.find((table) => tableTabId(table) === tab.id);
        return fresh ? { ...tab, table: fresh } : tab;
      }));
      setSelectedTable((current) => {
        if (!current) return current;
        return next.find((table) => tableTabId(table) === tableTabId(current)) ?? current;
      });
      if (active.engine === "postgres") setDbSchemas(await readSchemas(active.id));
    } catch (caught) {
      setViews((current) => ({
        ...current,
        [sqlTabId]: { ...(current[sqlTabId] ?? emptyView()), status: errorMessage(caught) },
      }));
    }
  };

  refreshSchemaRef.current = () => void refreshSchema();

  const runWrite = useCallback(async (sql: string, params: SqlValue[] = []) => {
    if (!active || writeLock.current) return false;
    writeLock.current = true;
    writeError.current = null;
    setFormError(null);
    setRunning(true);
    const queryId = crypto.randomUUID();
    activeQuery.current = queryId;
    try {
      const result = await guarded((authorized) => executeQuery(
        { connectionId: active.id, queryId, sql, params, chunkRows: 100, authorized },
        () => undefined,
      ));
      return !result.cancelled;
    } catch (caught) {
      const message = errorMessage(caught);
      writeError.current = message;
      setFormError(message);
      return false;
    } finally {
      writeLock.current = false;
      activeQuery.current = null;
      setRunning(false);
    }
  }, [active, guarded]);

  const runBatch = useCallback(async (statements: BatchStatement[]) => {
    if (!active || writeLock.current) return false;
    writeLock.current = true;
    writeError.current = null;
    setFormError(null);
    setRunning(true);
    try {
      await guarded((authorized) => executeBatch(active.id, statements, authorized));
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      writeError.current = message;
      setFormError(message);
      return false;
    } finally {
      writeLock.current = false;
      setRunning(false);
    }
  }, [active, guarded]);

  const runQuery = useCallback(async (tabId = sqlTabId, sql?: string | string[]) => {
    if (!active || running) return;
    const requested = Array.isArray(sql) ? sql : [sql ?? editorRef.current?.getActiveSql() ?? ""];
    const statements = requested.map((item) => item.trim()).filter(Boolean);
    if (statements.length === 0) {
      setViews((current) => ({
        ...current,
        [tabId]: { ...(current[tabId] ?? emptyView()), status: "Selecciona un comando o escribe SQL." },
      }));
      return;
    }
    const connectionId = active.id;
    const total = statements.length;
    let queryId = crypto.randomUUID();
    activeQuery.current = queryId;
    runningTab.current = tabId;
    const rows = rowsByTab.current[tabId] ?? [];
    rowsByTab.current[tabId] = rows;
    setRunning(true);
    const started = performance.now();
    let affected = 0;
    let changedSchema = false;
    let failedSql: string | null = null;
    let scriptAuthorized = false;
    try {
      let result: Awaited<ReturnType<typeof executeQuery>> | null = null;
      for (let index = 0; index < total; index += 1) {
        const statement = statements[index] ?? "";
        const thisQuery = index === 0 ? queryId : crypto.randomUUID();
        queryId = thisQuery;
        activeQuery.current = thisQuery;
        rows.length = 0;
        const prefix = total > 1 ? `${index + 1}/${total} · ` : "";
        setViews((current) => ({ ...current, [tabId]: { columns: [], rowCount: 0, status: `${prefix}Ejecutando…`, error: null, pending: true, ran: true } }));
        const execute = (authorized: boolean) => executeQuery(
          { connectionId, queryId: thisQuery, sql: statement, params: [], chunkRows: 500, authorized },
          (chunk) => {
              if (chunk.queryId !== thisQuery) return;
              if (chunk.rows.length > 0) rows.push(...chunk.rows);
              setViews((current) => {
                const previous = current[tabId] ?? emptyView();
                const columns = chunk.index === 0 && chunk.columns.length > 0 ? chunk.columns : previous.columns;
                return { ...current, [tabId]: { ...previous, columns, rowCount: rows.length } };
              });
            },
          );
        try {
          try {
            result = await execute(scriptAuthorized);
          } catch (caught) {
            if (!(caught instanceof GuardError) || caught.info.mode !== "confirm") throw caught;
            if (!(await askGuard(caught.info, total - index > 1))) throw new Error("No se ejecutó: falta tu autorización.", { cause: caught });
            scriptAuthorized = true;
            result = await execute(true);
          }
        } catch (caught) {
          setHistory(pushHistory(connectionId, { sql: statement, at: Date.now(), durationMs: null, ok: false }));
          failedSql = statement;
          if (total === 1) throw caught;
          throw new Error(`Sentencia ${index + 1} de ${total}: ${errorMessage(caught)}`, { cause: caught });
        }
        setHistory(pushHistory(connectionId, { sql: statement, at: Date.now(), durationMs: result.durationMs, ok: true }));
        affected += result.rowsAffected;
        if (schemaChange.test(statement)) changedSchema = true;
        if (/^\s*(begin|start\s+transaction)\b/i.test(statement)) setInTransaction(true);
        else if (/^\s*(commit|end|abort|rollback)\b(?!\s+to\b)/i.test(statement)) setInTransaction(false);
        if (result.cancelled) break;
      }
      if (!result) return;
      const finalResult = result;
      const notes = [
        finalResult.cancelled ? "cancelada" : null,
        finalResult.truncated ? "truncada a 1.000.000 filas" : null,
      ].filter((note) => note !== null);
      const returnsRows = finalResult.columns.length > 0 || finalResult.rowCount > 0;
      const headline = total > 1
        ? `${total} sentencias · ${returnsRows ? `${finalResult.rowCount} filas en la última` : `${affected} filas afectadas`}`
        : returnsRows ? `${finalResult.rowCount} filas` : `${finalResult.rowsAffected} filas afectadas`;
      const duration = total > 1 ? Math.round(performance.now() - started) : finalResult.durationMs;
      const status = `${headline} · ${duration} ms${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
      setViews((current) => ({
        ...current,
        [tabId]: {
          columns: finalResult.columns.length > 0 ? finalResult.columns : (current[tabId]?.columns ?? []),
          rowCount: rows.length,
          status,
          error: null,
          pending: false,
          ran: true,
        },
      }));
    } catch (caught) {
      if (activeQuery.current === queryId) {
        const shown = describeError(errorMessage(caught), failedSql, active.engine);
        const at = new Date().toLocaleTimeString("es");
        setViews((current) => ({
          ...current,
          [tabId]: { columns: [], rowCount: 0, status: `Error · ${at}`, error: shown, pending: false, ran: true },
        }));
      }
    } finally {
      if (activeQuery.current === queryId) {
        setRunning(false);
        runningTab.current = null;
      }
    }
    if (changedSchema) {
      refreshSchemaRef.current();
      editorRef.current?.relint();
    }
  }, [active, askGuard, running]);

  const formatEditor = () => {
    try {
      editorRef.current?.format();
    } catch (caught) {
      setStatus(sqlTabId, `No se pudo formatear: ${errorMessage(caught)}`);
    }
  };

  const runScript = () => {
    const statements = splitStatements(editorRef.current?.getValue() ?? "");
    void runQuery(sqlTabId, statements);
  };

  const queryQueue = useRef(Promise.resolve());
  const collectQuery = useCallback(async (sql: string, chunkRows = 100) => {
    if (!active) throw new Error("No hay una conexión activa");
    const connectionId = active.id;
    const run = async () => {
      let result: Awaited<ReturnType<typeof executeQuery>> | null = null;
      let rows: SqlValue[][] = [];
      let columns: ColumnDefinition[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const queryId = crypto.randomUUID();
        activeQuery.current = queryId;
        rows = [];
        columns = [];
        result = await executeQuery(
          { connectionId, queryId, sql, params: [], chunkRows },
          (chunk) => {
            if (chunk.queryId !== queryId) return;
            if (chunk.index === 0 && chunk.columns.length > 0) columns = chunk.columns;
            const incoming = Array.isArray(chunk.rows) ? chunk.rows : [];
            for (const row of incoming) rows.push(row.slice());
          },
        );
        if (Number(result.rowCount) <= rows.length) break;
      }
      if (!result) throw new Error("La consulta no devolvió resultado");
      if (columns.length === 0) columns = result.columns;
      if (Number(result.rowCount) > rows.length) {
        throw new Error(`Llegaron ${rows.length} de ${result.rowCount} filas`);
      }
      return { result, rows, columns };
    };
    const queued = queryQueue.current.then(run, run);
    queryQueue.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [active]);

  const loadTable = useCallback(async (table: TableSchema, page: number, pageSize: number, keepPending = false, discard = false) => {
    if (!active || writeLock.current) return;
    const id = tableTabId(table);
    const size = pageSizes.includes(pageSize) ? pageSize : 100;
    setPickedRows([]);
    if (!keepPending) {
      // Leaving this page: keep its edits aside with the rows they point at.
      const edit = pendingRef.current[id];
      const shown = loadedPage.current[id];
      if (edit && shown && !pendingEmpty(edit) && !discard) {
        const others = (stashRef.current[id] ?? []).filter((item) => item.key !== shown.key);
        putStashes({
          ...stashRef.current,
          [id]: [...others, { key: shown.key, label: shown.label, edit: clonePending(edit), rows: (rowsByTab.current[id] ?? []).map((row) => row.slice()), columns: shown.columns }],
        });
      }
      undoStack.current = undoStack.current.filter((entry) => entry.id !== id);
      setPending((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        pendingRef.current = next;
        return next;
      });
    }
    runningTab.current = id;
    setViews((current) => ({
      ...current,
      [id]: { ...(current[id] ?? emptyView()), status: "Contando filas…", error: null },
    }));
    setRunning(true);
    try {
      const query = tableQueryRef.current[id];
      const where = whereClause(query?.filters ?? [], active.engine);
      const order = orderClause(table, query?.sort ?? null);
      const counted = await collectQuery(`select count(*) as total from ${qualifiedName(table)}${where}`);
      if (counted.result.cancelled && counted.rows.length === 0) return;
      const total = countValue(counted.rows[0]?.[0]);
      const lastPage = Math.max(0, Math.ceil(total / size) - 1);
      const nextPage = Math.min(Math.max(0, page), lastPage);
      const offset = nextPage * size;
      setViews((current) => ({
        ...current,
        [id]: { ...(current[id] ?? emptyView()), status: "Cargando…" },
      }));
      const loaded = await collectQuery(
        `select * from ${qualifiedName(table)}${where}${order} limit ${size} offset ${offset}`,
      );
      if (loaded.result.cancelled && loaded.rows.length === 0) return;
      const bucket = rowsByTab.current[id] ?? [];
      bucket.length = 0;
      for (const row of loaded.rows) bucket.push(row);
      rowsByTab.current[id] = bucket;
      const from = total === 0 ? 0 : offset + 1;
      const to = offset + loaded.rows.length;
      const range = total === 0
        ? where ? "Ninguna fila cumple el filtro" : "0 filas"
        : `${from.toLocaleString("es")}–${to.toLocaleString("es")} de ${total.toLocaleString("es")}`;
      const columns = mergeColumns(loaded.columns, table);
      setViews((current) => ({
        ...current,
        [id]: {
          columns,
          rowCount: loaded.rows.length,
          status: `${range} · ${loaded.result.durationMs} ms`,
        },
      }));
      setPaging((current) => ({ ...current, [id]: { page: nextPage, pageSize: size, total } }));
      const key = viewKey(nextPage, size, query);
      loadedPage.current[id] = { key, label: viewLabel(nextPage, query), columns };
      // Back on a page with stashed edits: restore them if the rows are still the same.
      const stash = keepPending ? undefined : (stashRef.current[id] ?? []).find((item) => item.key === key);
      if (stash && primaryKeyList(table, stash.columns, stash.rows) === primaryKeyList(table, columns, loaded.rows)) {
        putStashes({ ...stashRef.current, [id]: (stashRef.current[id] ?? []).filter((item) => item !== stash) });
        const next = { ...pendingRef.current, [id]: stash.edit };
        pendingRef.current = next;
        setPending(next);
      }
    } catch (caught) {
      if (runningTab.current === id) {
        const shown = describeError(errorMessage(caught), null, active.engine);
        setViews((current) => ({
          ...current,
          [id]: { ...(current[id] ?? emptyView()), status: "Error", error: shown },
        }));
      }
    } finally {
      if (runningTab.current === id) {
        setRunning(false);
        runningTab.current = null;
      }
    }
  }, [active, collectQuery, putStashes]);

  const forgetTab = (id: string) => {
    if (stashRef.current[id]) {
      const next = { ...stashRef.current };
      delete next[id];
      putStashes(next);
    }
    delete loadedPage.current[id];
    setStructureDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (runningTab.current === id && activeQuery.current) void cancelQuery(activeQuery.current);
    delete rowsByTab.current[id];
    delete rowHandles.current[id];
    undoStack.current = undoStack.current.filter((entry) => entry.id !== id);
    setPending((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      pendingRef.current = next;
      return next;
    });
    setPaging((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete tableQueryRef.current[id];
    setTableQueries({ ...tableQueryRef.current });
    setFocusedRow((current) => (current?.tab === id ? null : current));
  };

  useEffect(() => {
    if (!active) return undefined;
    const loads = pendingLoads.current;
    pendingLoads.current = [];
    for (const table of loads) void loadTable(table, 0, 100);
    return undefined;
  }, [active, loadTable]);

  useEffect(() => {
    if (!active) return undefined;
    writeSession(active.id, {
      sql: editorRef.current?.getValue() ?? readSession(active.id)?.sql ?? "",
      activeTab: activeTabId,
      tabs: workspaceTabs(tableTabs),
    });
    return undefined;
  }, [active, activeTabId, tableTabs]);

  const pinTable = (id: string) => {
    setTableTabs((current) => {
      const tab = current.find((item) => item.id === id);
      if (!tab || tab.pinned) return current;
      return current.map((item) => (item.id === id ? { ...item, pinned: true } : item));
    });
  };

  const openTable = (table: TableSchema, pin = false) => {
    const id = tableTabId(table);
    const existing = tableTabs.find((tab) => tab.id === id);
    if (existing) {
      if (pin) pinTable(id);
      setActiveTabId(id);
      setSelectedTable(table);
      return;
    }
    if (!pin) {
      for (const tab of tableTabs) {
        if (!tab.pinned) forgetTab(tab.id);
      }
    }
    setTableTabs((current) => {
      const kept = pin ? current : current.filter((tab) => tab.pinned);
      return [...kept, { id, table, pinned: pin }];
    });
    setActiveTabId(id);
    setSelectedTable(table);
    if (!showsRows(table)) {
      setViews((current) => ({
        ...current,
        [id]: emptyView(table.definition ? "" : "Sin definición."),
      }));
      return;
    }
    void loadTable(table, 0, paging[id]?.pageSize ?? 100);
  };

  const openTableNamed = (schema: string | null, name: string) => {
    const target = findTable(tables, schema, name);
    if (target) openTable(target, true);
  };

  /** Opens the table a foreign key points at, filtered to the row this one references. */
  const openReferenced = (key: ForeignKey, columns: ColumnDefinition[], row: SqlValue[]) => {
    const target = findTable(tables, key.refSchema, key.refTable);
    if (!target) return;
    const refColumns = resolvedRefColumns(key, tables);
    const filters: TableFilter[] = key.columns.map((column, index) => {
      const value = row[columns.findIndex((item) => item.name === column)];
      const isNull = !value || value.t === "null";
      return {
        id: crypto.randomUUID(),
        column: refColumns[index] ?? column,
        op: isNull ? "null" : "=",
        value: isNull ? "" : formatSqlValue(value),
        enabled: true,
      };
    });
    const id = tableTabId(target);
    tableQueryRef.current = { ...tableQueryRef.current, [id]: { filters, sort: null } };
    setTableQueries(tableQueryRef.current);
    setFilterDrafts((current) => ({ ...current, [id]: filters }));
    setFilterOpen((current) => ({ ...current, [id]: true }));
    if (tableTabs.some((tab) => tab.id === id)) {
      focusTab(id);
      void loadTable(target, 0, paging[id]?.pageSize ?? 100);
    } else {
      openTable(target, true);
    }
  };

  const closeTable = async (id: string) => {
    if (!(await confirmDiscardRef.current({ tab: id, action: "Cerrar la pestaña" }))) return;
    setTableTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTabId((current) => (current === id ? sqlTabId : current));
    forgetTab(id);
  };

  const focusTab = (id: string) => {
    setActiveTabId(id);
    const tab = tableTabs.find((item) => item.id === id);
    if (tab) setSelectedTable(tab.table);
  };

  const needle = objectQuery.trim().toLowerCase();
  const schemaNames = useMemo(() => {
    const names = new Set(dbSchemas);
    for (const table of tables) {
      if (table.schema) names.add(table.schema);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [dbSchemas, tables]);
  const activeSchema = schemaNames.includes(schemaChoice)
    ? schemaChoice
    : schemaNames.includes("public")
      ? "public"
      : (schemaNames[0] ?? "");
  const searched = tables.filter((table) => {
    if (!needle) return true;
    return table.name.toLowerCase().includes(needle) || (table.schema ?? "").toLowerCase().includes(needle);
  });
  const branchOpen = (key: string, fallback: boolean) => {
    if (key in expanded) return expanded[key];
    if (needle) return true;
    return fallback;
  };
  const toggleBranch = (key: string, fallback: boolean) => {
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? fallback) }));
  };

  const renderGroups = (schema: string | null, groupDepth: string, leafDepth: string) => {
    const owned = searched.filter((table) => (engine === "postgres" ? table.schema === schema : true));
    const tableKey = `tables:${schema ?? "main"}`;
    const tableRows = owned.filter((table) => table.kind === "table");
    return (
      <>
        {!needle || tableRows.length > 0 ? (
          <TreeBranch
            label="Tablas"
            depth={groupDepth}
            icon={<Folder size={14} />}
            open={branchOpen(tableKey, true)}
            onToggle={() => toggleBranch(tableKey, true)}
            actions={
              <button
                type="button"
                className="tiny-icon"
                aria-label="Nueva tabla"
                disabled={structureLocked || running || (engine === "postgres" && !schema)}
                onClick={() => {
                  if (schema) setSchemaChoice(schema);
                  openDialog({ kind: "create-table" });
                }}
              >
                <Plus size={14} />
              </button>
            }
          >
            {tableRows.map((table) => (
              <TableLeaf key={`${table.schema ?? ""}:${table.name}`} className={leafDepth} table={table} selected={selectedTable} onOpen={openTable} />
            ))}
          </TreeBranch>
        ) : null}
        {objectGroups.map((group) => {
          const items = owned.filter((table) => table.kind === group.kind);
          if (items.length === 0) return null;
          const key = `${group.kind}:${schema ?? "main"}`;
          return (
            <TreeBranch
              key={group.kind}
              label={group.label}
              depth={groupDepth}
              icon={<Folder size={14} />}
              open={branchOpen(key, false)}
              onToggle={() => toggleBranch(key, false)}
            >
              {items.map((table) => (
                <TableLeaf key={`${table.schema ?? ""}:${table.name}:${table.kind}`} className={leafDepth} table={table} selected={selectedTable} onOpen={openTable} />
              ))}
            </TreeBranch>
          );
        })}
      </>
    );
  };
  const activeTable = tableTabs.find((tab) => tab.id === activeTabId) ?? null;
  const detailTable = activeTable?.table ?? selectedTable;
  const sqlView = views[sqlTabId] ?? emptyView();
  const tableView = activeTable ? (views[activeTable.id] ?? emptyView()) : null;
  const writable = activeTable ? canEditRows(activeTable.table, editLocked) : false;
  const structureTable = activeTable?.table.kind === "table"
    ? activeTable.table
    : detailTable?.kind === "table"
      ? detailTable
      : null;

  const reloadOpenTable = async (table: TableSchema, keepPending = false) => {
    await refreshSchema();
    const page = paging[tableTabId(table)];
    await loadTable(table, page?.page ?? 0, page?.pageSize ?? 100, keepPending);
  };

  const moveSchema = (from: string, to: string) => {
    const moves = tableTabs.flatMap((tab) => {
      if (tab.table.schema !== from) return [];
      const table = { ...tab.table, schema: to };
      return [{ from: tab.id, to: tableTabId(table), table }];
    });
    for (const move of moves) {
      if (move.from === move.to) continue;
      rowsByTab.current[move.to] = rowsByTab.current[move.from] ?? [];
      delete rowsByTab.current[move.from];
      const handle = rowHandles.current[move.from];
      if (handle) {
        handle.current = rowsByTab.current[move.to];
        rowHandles.current[move.to] = handle;
        delete rowHandles.current[move.from];
      }
    }
    const remap = <T,>(record: Record<string, T>) => {
      const next = { ...record };
      for (const move of moves) {
        if (move.from === move.to || !(move.from in next)) continue;
        next[move.to] = next[move.from];
        delete next[move.from];
      }
      return next;
    };
    setTableTabs((current) => current.map((tab) => {
      const move = moves.find((item) => item.from === tab.id);
      return move ? { ...tab, id: move.to, table: move.table } : tab;
    }));
    setPaging(remap);
    setViews(remap);
    undoStack.current = undoStack.current.map((entry) => {
      const move = moves.find((item) => item.from === entry.id);
      return move && move.from !== move.to ? { ...entry, id: move.to } : entry;
    });
    setPending(remap);
    setActiveTabId((current) => moves.find((item) => item.from === current)?.to ?? current);
    setSelectedTable((current) => (current?.schema === from ? { ...current, schema: to } : current));
    setSchemaChoice(to);
  };

  const openDialog = (next: WorkspaceDialog) => {
    setFormError(null);
    setDialog(next);
  };

  const submitName = async (name: string) => {
    if (!dialog || (dialog.kind !== "create-schema" && dialog.kind !== "rename-schema")) return;
    try {
      const sql = dialog.kind === "create-schema" ? createSchemaSql(name) : renameSchemaSql(dialog.name, name);
      const ok = await runWrite(sql);
      if (!ok) return;
      if (dialog.kind === "rename-schema") moveSchema(dialog.name, name.trim());
      else setSchemaChoice(name.trim());
      setDialog(null);
      await refreshSchema();
    } catch (caught) {
      setFormError(errorMessage(caught));
    }
  };

  const submitDropSchema = async () => {
    if (dialog?.kind !== "drop-schema") return;
    try {
      const ok = await runWrite(dropSchemaSql(dialog.name));
      if (!ok) return;
      if (activeSchema === dialog.name) setSchemaChoice("public");
      setDialog(null);
      await refreshSchema();
    } catch (caught) {
      setFormError(errorMessage(caught));
    }
  };

  const submitTable = async (name: string, columns: Parameters<typeof createTableSql>[2]) => {
    try {
      const sql = createTableSql(engine === "postgres" ? activeSchema || null : null, name, columns, engine);
      const ok = await runWrite(sql);
      if (!ok) return;
      setDialog(null);
      await refreshSchema();
    } catch (caught) {
      setFormError(errorMessage(caught));
    }
  };

  const saveStructure = async (statements: string[]) => {
    if (!structureTable || statements.length === 0) return;
    pinTable(tableTabId(structureTable));
    const dropsColumn = statements.some((sql) => /\bdrop column\b/i.test(sql));
    const ok = await runBatch(statements.map((sql) => ({ sql, params: [] })));
    if (!ok) return;
    const id = tableTabId(structureTable);
    setStructureDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    await reloadOpenTable(structureTable, !dropsColumn);
  };

  const updatePending = (id: string, recipe: (edit: PendingChanges) => PendingChanges) => {
    const previous = pendingRef.current[id];
    const edit = recipe(previous ? clonePending(previous) : { inserts: [], removed: [], edits: {} });
    const empty = pendingEmpty(edit);
    const before = previous ? clonePending(previous) : null;
    if (JSON.stringify(before) === JSON.stringify(empty ? null : edit)) return;
    undoStack.current.push({ id, before });
    if (undoStack.current.length > 100) undoStack.current.shift();
    const next = { ...pendingRef.current };
    if (empty) delete next[id];
    else next[id] = edit;
    pendingRef.current = next;
    setPending(next);
  };

  const undoChange = () => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    const next = { ...pendingRef.current };
    if (entry.before) next[entry.id] = clonePending(entry.before);
    else delete next[entry.id];
    pendingRef.current = next;
    setPending(next);
    setFormError(null);
  };

  const startDraft = () => {
    if (!activeTable || !tableView || tableView.columns.length === 0) return;
    pinTable(activeTable.id);
    const blank = tableView.columns.map((): SqlValue => ({ t: "null" }));
    updatePending(activeTable.id, (edit) => ({ ...edit, inserts: [...edit.inserts, blank] }));
    setFormError(null);
  };

  const editInsert = (row: number, column: number, value: SqlValue) => {
    if (!activeTable) return;
    pinTable(activeTable.id);
    updatePending(activeTable.id, (edit) => ({
      ...edit,
      inserts: edit.inserts.map((line, index) => {
        if (index !== row) return line;
        const next = line.slice();
        next[column] = value;
        return next;
      }),
    }));
  };

  const editCell = (row: number, column: number, value: SqlValue) => {
    if (!activeTable || !tableView) return;
    pinTable(activeTable.id);
    const id = activeTable.id;
    const original = rowsByTab.current[id]?.[row];
    if (!original || column < 0 || column >= tableView.columns.length) return;
    updatePending(id, (edit) => {
      const base = (edit.edits?.[row] ?? original).slice();
      while (base.length < tableView.columns.length) base.push({ t: "null" });
      base[column] = value;
      const next = base;
      const edits = { ...(edit.edits ?? {}) };
      if (sameDisplayedRow(next, original)) delete edits[row];
      else edits[row] = next;
      return { ...edit, edits };
    });
    setFormError(null);
  };

  const dropInserts = (indexes: number[]) => {
    if (!activeTable) return;
    pinTable(activeTable.id);
    const drop = new Set(indexes);
    updatePending(activeTable.id, (edit) => ({
      ...edit,
      inserts: edit.inserts.filter((_, index) => !drop.has(index)),
    }));
  };

  const markRows = (indexes: number[]) => {
    if (!activeTable || !tableView) return;
    pinTable(activeTable.id);
    const limit = tableView.rowCount;
    updatePending(activeTable.id, (edit) => {
      const removed = new Set(edit.removed);
      for (const index of indexes) {
        if (index < 0 || index >= limit) continue;
        if (removed.has(index)) removed.delete(index);
        else removed.add(index);
      }
      return { ...edit, removed: [...removed].sort((left, right) => left - right) };
    });
    setFormError(null);
  };

  const dropStashes = (id: string) => {
    if (!stashRef.current[id]) return;
    const next = { ...stashRef.current };
    delete next[id];
    putStashes(next);
  };

  const discardEdits = () => {
    if (!activeTable) return;
    updatePending(activeTable.id, () => ({ inserts: [], removed: [], edits: {} }));
    dropStashes(activeTable.id);
    setFormError(null);
  };

  /** Statements for the active table: edits stashed on other pages first, then this page's. */
  const pendingStatements = (): BatchStatement[] => {
    if (!activeTable || !tableView) return [];
    const statements: BatchStatement[] = [];
    for (const stash of stashRef.current[activeTable.id] ?? []) {
      statements.push(...editStatements(activeTable.table, stash.edit, stash.rows, stash.columns));
    }
    const edit = pending[activeTable.id];
    if (edit) statements.push(...editStatements(activeTable.table, edit, rowsByTab.current[activeTable.id] ?? [], tableView.columns));
    return statements;
  };

  /** Statements that apply `edit`, made against `rows` as they were loaded. */
  const editStatements = (table: TableSchema, edit: PendingChanges, rows: SqlValue[][], columns: ColumnDefinition[]): BatchStatement[] => {
    const removed = edit.removed.filter((index) => index >= 0 && index < rows.length);
    const removedSet = new Set(removed);
    const statements: BatchStatement[] = [];
    for (const [key, values] of Object.entries(edit.edits ?? {})) {
      const index = Number(key);
      if (!Number.isInteger(index) || removedSet.has(index)) continue;
      const original = rows[index];
      if (!original) continue;
      try {
        statements.push(updateSql(engine, table, rowRecord(columns, original), fieldsFromValues(columns, values)));
      } catch (caught) {
        if (errorMessage(caught) === "No hay cambios") continue;
        throw caught;
      }
    }
    for (const index of removed) {
      statements.push(deleteSql(engine, table, rowRecord(columns, rows[index] ?? [])));
    }
    for (const values of edit.inserts) {
      statements.push(insertSql(engine, table, fieldsFromDraft(table, columns, values)));
    }
    return statements;
  };

  const clearPending = (id: string) => {
    undoStack.current = undoStack.current.filter((entry) => entry.id !== id);
    setPending((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      pendingRef.current = next;
      return next;
    });
  };

  const previewEdits = () => {
    setFormError(null);
    try {
      const statements = pendingStatements();
      if (statements.length > 0) setPreview(statements);
    } catch (caught) {
      setFormError(errorMessage(caught));
    }
  };

  const saveEdits = async () => {
    if (!activeTable || !tableView || running || writeLock.current) return;
    const id = activeTable.id;
    if (!pending[id] && !(stashRef.current[id]?.length)) return;
    setFormError(null);
    let statements: BatchStatement[];
    try {
      statements = pendingStatements();
    } catch (caught) {
      setFormError(errorMessage(caught));
      return;
    }
    if (statements.length === 0) {
      clearPending(id);
      dropStashes(id);
      setPreview(null);
      return;
    }
    // One transaction: if any row fails, nothing is written and the edits stay pending.
    const ok = await runBatch(statements);
    if (!ok) return;
    setPreview(null);
    clearPending(id);
    dropStashes(id);
    await reloadOpenTable(activeTable.table);
  };

  const changeQuery = (table: TableSchema, query: TableQuery) => {
    const id = tableTabId(table);
    tableQueryRef.current = { ...tableQueryRef.current, [id]: query };
    setTableQueries(tableQueryRef.current);
    void loadTable(table, 0, paging[id]?.pageSize ?? 100);
  };

  const applyFilters = (table: TableSchema, filters: TableFilter[]) => {
    const id = tableTabId(table);
    changeQuery(table, { filters, sort: tableQueryRef.current[id]?.sort ?? null });
  };

  const sortBy = (table: TableSchema, column: string) => {
    const id = tableTabId(table);
    const current = tableQueryRef.current[id];
    changeQuery(table, { filters: current?.filters ?? [], sort: nextSort(current?.sort ?? null, column) });
  };

  const setStatus = (tabId: string, status: string) => {
    setViews((current) => ({ ...current, [tabId]: { ...(current[tabId] ?? emptyView()), status } }));
  };

  const exportResult = async (tabId: string, format: ExportFormat) => {
    if (!active) return;
    const table = tabId === sqlTabId ? null : (tableTabs.find((tab) => tab.id === tabId)?.table ?? null);
    try {
      const path = await save({
        defaultPath: `${table?.name ?? "resultado"}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      let columns: ColumnDefinition[];
      let rows: SqlValue[][];
      if (table) {
        setStatus(tabId, "Exportando…");
        const query = tableQueryRef.current[tabId];
        const loaded = await collectQuery(
          `select * from ${qualifiedName(table)}${whereClause(query?.filters ?? [], engine)}${orderClause(table, query?.sort ?? null)}`,
          2000,
        );
        columns = loaded.columns;
        rows = loaded.rows;
      } else {
        columns = views[sqlTabId]?.columns ?? [];
        rows = rowsByTab.current[sqlTabId] ?? [];
      }
      const target = table ? qualifiedName(table) : quoteIdent("resultado");
      await writeExport(path, exportRows(format, columns, rows, engine, target));
      setStatus(tabId, `${rows.length.toLocaleString("es")} filas exportadas a ${path}`);
    } catch (caught) {
      setStatus(tabId, `No se pudo exportar: ${errorMessage(caught)}`);
    }
  };

  const pasteRows = (startColumn: number, matrix: string[][]) => {
    if (!activeTable || !tableView || !writable) return;
    pinTable(activeTable.id);
    const lines = matrix.filter((row) => row.some((cell) => cell.trim() !== ""));
    const body = isHeaderRow(lines[0] ?? [], tableView.columns) ? lines.slice(1) : lines;
    if (body.length === 0) return;
    const inserts = body.map((line) => pastedRow(tableView.columns, line, startColumn));
    updatePending(activeTable.id, (edit) => ({ ...edit, inserts: [...edit.inserts, ...inserts] }));
    setFormError(null);
  };

  saveEditsRef.current = () => void saveEdits();
  /** Cmd+R: reload the open table, dropping this page's edits after asking; in the SQL tab, refresh the explorer. */
  reloadRef.current = () => {
    if (screen !== "workspace" || running || document.querySelector(".modal-backdrop")) return;
    if (!activeTable || !showsRows(activeTable.table)) {
      void refreshSchema();
      return;
    }
    const table = activeTable.table;
    const id = activeTable.id;
    void confirmDiscardRef.current({ tab: id, action: "Recargar", currentPageOnly: true }).then((ok) => {
      if (!ok) return;
      const page = paging[id];
      void loadTable(table, page?.page ?? 0, page?.pageSize ?? 100, false, true);
    });
  };
  closeTabRef.current = () => {
    if (screen !== "workspace" || activeTabId === sqlTabId) return;
    if (document.querySelector(".modal-backdrop")) return;
    closeTable(activeTabId);
  };
  workspaceState.current = { id: active?.id ?? null, tabs: tableTabs, activeTabId };

  const onSqlChange = (sql: string) => {
    const id = activeRef.current?.id;
    if (!id) return;
    const state = workspaceState.current;
    writeSession(id, { sql, activeTab: state.activeTabId, tabs: workspaceTabs(state.tabs) });
  };
  undoRef.current = undoChange;

  useEffect(() => {
    if (screen === "home") return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey) return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        if (document.querySelector(".modal-backdrop")) return;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        if (active instanceof HTMLElement && active.closest(".cm-editor, .structure-editor")) return;
        event.preventDefault();
        undoRef.current();
        return;
      }
      if (event.shiftKey || key !== "s") return;
      event.preventDefault();
      if (document.querySelector(".modal-backdrop")) return;
      const active = document.activeElement;
      const editingCell = active instanceof HTMLElement
        && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        && active.closest(".grid-wrap");
      if (editingCell) {
        active.blur();
        window.setTimeout(() => saveEditsRef.current(), 0);
        return;
      }
      saveEditsRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  /** What leaving would lose, optionally limited to one table tab. */
  const unsavedItems = (tab?: string, currentPageOnly = false): string[] => {
    const items: string[] = [];
    const nameOf = (id: string) => tableTabs.find((item) => item.id === id)?.table.name ?? id;
    for (const [id, edit] of Object.entries(pending)) {
      if (tab && id !== tab) continue;
      const summary = describePending(edit).replace(/\. Guarda para aplicar\.$/, "");
      if (summary) items.push(`${nameOf(id)}: ${summary}`);
    }
    for (const [id, list] of Object.entries(currentPageOnly ? {} : stashes)) {
      if (tab && id !== tab) continue;
      for (const stash of list) {
        const summary = describePending(stash.edit).replace(/\. Guarda para aplicar\.$/, "");
        if (summary) items.push(`${nameOf(id)} (${stash.label}): ${summary}`);
      }
    }
    for (const [id, draft] of Object.entries(currentPageOnly ? {} : structureDrafts)) {
      if (tab && id !== tab) continue;
      const table = tableTabs.find((item) => item.id === id)?.table;
      if (table && structureKey(table) === draft.signature) items.push(`Estructura de ${table.name}: cambios de columnas sin aplicar`);
    }
    if (!tab && inTransaction) items.push("Editor SQL: transacción abierta sin COMMIT; al salir se revierte");
    return items;
  };
  const unsaved = unsavedItems().length > 0;
  confirmDiscardRef.current = (scope) => {
    const items = unsavedItems(scope?.tab, scope?.currentPageOnly);
    if (items.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      discardResolve.current?.(false);
      discardResolve.current = resolve;
      setDiscardAsk({ items, action: scope?.action ?? "Continuar" });
    });
  };
  const answerDiscard = (ok: boolean) => {
    discardResolve.current?.(ok);
    discardResolve.current = null;
    setDiscardAsk(null);
  };

  useEffect(() => {
    void setUnsaved(unsaved).catch(() => undefined);
  }, [unsaved]);

  useEffect(() => {
    let stop = () => {};
    // The shell holds the window close and Cmd+Q while edits are pending.
    void listen("gridl-quit-requested", () => {
      void confirmDiscardRef.current({ action: "Salir de Gridl" }).then((ok) => {
        if (ok) void quitDiscarding();
      });
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, []);

  if (screen === "home") {
    return (
      <ConnectionHome
        catalog={catalog}
        busy={busy}
        error={error}
        onCreateGroup={addGroup}
        onDeleteGroup={removeGroup}
        onDeleteConnection={removeConnection}
        onOpen={openSaved}
        onSave={saveDraft}
        onBrowse={browse}
        onTest={testDraft}
        pendingCommand={homeCommand}
      />
    );
  }

  const hostLine = !active
    ? ""
    : active.engine === "sqlite"
      ? active.database
      : `${active.host ?? "localhost"}:${active.port ?? (active.engine === "mysql" ? 3306 : 5432)}`;
  const focusView = views[activeTabId];
  const focusedValues = (() => {
    if (!focusedRow || focusedRow.tab !== activeTabId || !focusView || focusView.columns.length === 0) return null;
    const edit = pending[focusedRow.tab];
    const index = focusedRow.row;
    if (index >= focusView.rowCount) return edit?.inserts[index - focusView.rowCount] ?? null;
    return edit?.edits?.[index] ?? rowsByTab.current[focusedRow.tab]?.[index] ?? null;
  })();
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  /** What a right click on a cell offers: follow the foreign key, copy, filter, and edit. */
  const cellMenuItems = (menu: NonNullable<typeof cellMenu>): MenuItem[] => {
    const view = views[menu.tab];
    if (!view) return [];
    const columns = view.columns;
    const column = columns[menu.column];
    if (!column) return [];
    const tab = tableTabs.find((item) => item.id === menu.tab) ?? null;
    if (menu.range) {
      const range = menu.range;
      const writableRange = tab ? canEditRows(tab.table, editLocked) : false;
      const rowsLabel = range.rows === 1 ? "1 fila" : `${range.rows} filas`;
      const items: MenuItem[] = [
        { label: `Copiar ${range.cells} celdas`, hint: "⌘C", run: () => range.copy(false) },
        { label: "Copiar con encabezados", run: () => range.copy(true) },
      ];
      if (tab) items.push({ label: `Copiar ${rowsLabel} como INSERT`, run: () => range.copyInserts(qualifiedName(tab.table), engine) });
      if (writableRange) {
        items.push("separator");
        items.push({ label: "Pegar", hint: "⌘V", run: range.paste });
        items.push({ label: `Poner NULL en ${range.cells} celdas`, run: range.clear });
        items.push({ label: `Eliminar ${rowsLabel}`, hint: "⌫", danger: true, run: range.removeRows });
      }
      return items;
    }
    const edit = pending[menu.tab];
    const draftIndex = menu.row - view.rowCount;
    const values = draftIndex >= 0
      ? (edit?.inserts[draftIndex] ?? [])
      : (edit?.edits?.[menu.row] ?? rowsByTab.current[menu.tab]?.[menu.row] ?? []);
    const value = values[menu.column];
    const isNull = !value || value.t === "null";
    const items: MenuItem[] = [];
    if (tab && draftIndex < 0) {
      const key = keyForColumn(foreignKeys, tab.table, column.name);
      if (key && findTable(tables, key.refSchema, key.refTable)) {
        items.push({ label: `Abrir en ${key.refTable}`, disabled: isNull, run: () => openReferenced(key, columns, values) });
        items.push("separator");
      }
    }
    items.push({ label: "Copiar valor", run: () => copyText(isNull ? "" : formatSqlValue(value)) });
    items.push({ label: "Copiar fila", run: () => copyText(toTsv(columns, [values], false)) });
    items.push({ label: "Copiar fila con encabezados", run: () => copyText(toTsv(columns, [values], true)) });
    if (tab) {
      const target = qualifiedName(tab.table);
      items.push({
        label: "Copiar como INSERT",
        run: () => copyText(`INSERT INTO ${target} (${columns.map((item) => quoteIdent(item.name)).join(", ")}) VALUES (${columns.map((_, index) => sqlLiteral(values[index], engine)).join(", ")});`),
      });
    }
    if (tab && draftIndex < 0) {
      items.push("separator");
      items.push({
        label: isNull ? `Filtrar: ${column.name} es NULL` : `Filtrar: ${column.name} = ${formatSqlValue(value).slice(0, 40)}`,
        run: () => {
          const filter: TableFilter = { id: crypto.randomUUID(), column: column.name, op: isNull ? "null" : "=", value: isNull ? "" : formatSqlValue(value), enabled: true };
          const next = [...(tableQueryRef.current[menu.tab]?.filters ?? []), filter];
          setFilterDrafts((current) => ({ ...current, [menu.tab]: next }));
          setFilterOpen((current) => ({ ...current, [menu.tab]: true }));
          applyFilters(tab.table, next);
        },
      });
      const writableTab = canEditRows(tab.table, editLocked);
      if (writableTab) {
        items.push("separator");
        items.push({ label: "Poner NULL", disabled: isNull || !column.nullable, run: () => editCell(menu.row, menu.column, { t: "null" }) });
        items.push({ label: "Eliminar fila", danger: true, run: () => markRows([menu.row]) });
      }
    }
    return items;
  };

  const showRow = focusedValues !== null && focusView !== undefined && (detailsTab === "row" || !detailTable);

  return (
    <div className="workspace-shell">
      <header className={`workspace-topbar env-${safety.environment}`} data-tauri-drag-region>
        <button type="button" className="back-button" onClick={() => void goHome()}>
          <ArrowLeft size={17} /> Conexiones
        </button>
        <div className="workspace-separator" />
        <div className="connected-badge">
          <span className="status-dot online" /> {active?.name}
        </div>
        <span className="workspace-host" data-tauri-drag-region>{hostLine}</span>
        {safety.environment !== "local" ? (
          <span className={`env-pill env-${safety.environment}`} title="Ambiente de esta conexión">{environmentLabel(safety.environment)}</span>
        ) : null}
        {active?.readOnly ? <span className="readonly-badge">Solo lectura</span> : null}
      </header>
      <div
        className="workspace-body"
        ref={workspaceRef}
        style={{
          gridTemplateColumns: explorerOpen
            ? `${explorerWidth}px 5px minmax(0, 1fr) 5px ${detailsWidth}px`
            : `minmax(0, 1fr) 5px ${detailsWidth}px`,
        }}
      >
        {explorerOpen ? (
        <aside className="explorer">
          <div className="explorer-heading">
            <span>Explorador</span>
            <button type="button" className="tiny-icon" aria-label="Actualizar esquema" onClick={() => void refreshSchema()}>
              <Database size={15} />
            </button>
          </div>
          <div className="explorer-search">
            <Search size={14} />
            <input value={objectQuery} placeholder="Buscar objetos..." onChange={(event) => setObjectQuery(event.target.value)} />
          </div>
          <div className="tree-section">
            <TreeBranch
              label={active?.database || "Base de datos"}
              depth="depth-0 tree-root"
              icon={<Database size={15} />}
              open={branchOpen("db", true)}
              onToggle={() => toggleBranch("db", true)}
              actions={engine === "postgres" ? (
                <button type="button" className="tiny-icon" aria-label="Crear esquema" disabled={structureLocked || running} onClick={() => openDialog({ kind: "create-schema" })}>
                  <Plus size={14} />
                </button>
              ) : null}
            >
              {engine === "postgres" ? (
                schemaNames.filter((name) => !needle || searched.some((table) => table.schema === name) || name.toLowerCase().includes(needle)).map((name) => {
                  const key = `schema:${name}`;
                  const fallback = name === activeSchema;
                  return (
                    <TreeBranch
                      key={name}
                      label={name}
                      depth="depth-1"
                      icon={<Folder size={14} />}
                      active={name === activeSchema}
                      open={branchOpen(key, fallback)}
                      onToggle={() => {
                        const opening = !branchOpen(key, fallback);
                        toggleBranch(key, fallback);
                        if (opening) setSchemaChoice(name);
                      }}
                      actions={
                        <>
                          <button type="button" className="tiny-icon" aria-label={`Renombrar ${name}`} disabled={structureLocked || running} onClick={() => openDialog({ kind: "rename-schema", name })}>
                            <Pencil size={13} />
                          </button>
                          <button type="button" className="tiny-icon" aria-label={`Eliminar ${name}`} disabled={structureLocked || running} onClick={() => openDialog({ kind: "drop-schema", name })}>
                            <Trash2 size={13} />
                          </button>
                        </>
                      }
                    >
                      {renderGroups(name, "depth-2", "depth-3")}
                    </TreeBranch>
                  );
                })
              ) : renderGroups(null, "depth-1", "depth-2")}
              {engine === "postgres" && schemaNames.length === 0 ? <div className="tree-item depth-1">Sin esquemas</div> : null}
            </TreeBranch>
          </div>
        </aside>
        ) : null}
        {explorerOpen ? (
          <PaneSplitter
            label="Redimensionar explorador"
            onDrag={(delta) =>
              setExplorerWidth((current) => {
                const next = clampPane(current + delta, 200, paneLimit(workspaceRef.current, detailsWidth));
                window.localStorage.setItem("gridl.explorer", String(next));
                return next;
              })
            }
          />
        ) : null}
        <main className="editor-area">
          <div className="editor-tabs" role="tablist">
            <button type="button" role="tab" className={activeTabId === sqlTabId ? "active" : undefined} onClick={() => focusTab(sqlTabId)}>
              <TerminalSquare size={15} /> Editor SQL
            </button>
            {tableTabs.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                className={activeTabId === tab.id ? `editor-tab active${tab.pinned ? "" : " preview"}` : `editor-tab${tab.pinned ? "" : " preview"}`}
                onClick={() => focusTab(tab.id)}
                onDoubleClick={() => pinTable(tab.id)}
              >
                <ObjectIcon kind={tab.table.kind} size={15} />
                <span className="tab-label">{tab.table.name}</span>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Cerrar ${tab.table.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTable(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="editor-tab-actions">
              <button type="button" className="icon-button" aria-label="Explorador" onClick={() => setExplorerOpen((current) => !current)}>
                <PanelLeft size={16} />
              </button>
            </div>
          </div>
          <div ref={sqlStageRef} className={activeTabId === sqlTabId ? "editor-stage" : "editor-stage pane-off"}>
            <div className="editor-toolbar">
              <span>SQL</span>
              <div>
                <HistoryMenu
                  entries={history}
                  onPick={(sql) => editorRef.current?.insertSql(sql)}
                  onStar={(id) => active && setHistory(toggleStar(active.id, id))}
                  onRemove={(id) => active && setHistory(removeHistory(active.id, id))}
                  onClear={() => active && setHistory(clearHistory(active.id))}
                />
                <button type="button" className="toolbar-button" title="Formatea la selección o todo el script" onClick={formatEditor}>
                  <Braces size={14} /> Formatear <kbd>{formatShortcut}</kbd>
                </button>
                <ExportMenu disabled={running || sqlView.columns.length === 0} onExport={(format) => void exportResult(sqlTabId, format)} />
                <button
                  type="button"
                  className="toolbar-button"
                  disabled={!running || runningTab.current !== sqlTabId}
                  onClick={() => {
                    const queryId = activeQuery.current;
                    if (queryId) void cancelQuery(queryId);
                  }}
                >
                  Cancelar
                </button>
                <button type="button" className="toolbar-button" title="Ejecuta todas las sentencias del editor, una tras otra" disabled={!active || running || busy} onClick={runScript}>
                  <FastForward size={14} /> Todo <kbd>{runAllShortcut}</kbd>
                </button>
                <button type="button" className="run-button" title="Ejecuta la selección o el comando del cursor" disabled={!active || running || busy} onClick={() => void runQuery()}>
                  <Play size={14} /> Ejecutar <kbd>{runShortcut}</kbd>
                </button>
              </div>
            </div>
            <SqlEditor
              ref={editorRef}
              engine={engine}
              schema={schema}
              initialSql={sqlSeed}
              visible={activeTabId === sqlTabId}
              onChange={onSqlChange}
              onRun={() => void runQuery()}
              onRunAll={runScript}
              onFormat={formatEditor}
              checker={checker}
            />
            {sqlView.ran ? (
              <>
                <PaneSplitter
                  axis="y"
                  label="Redimensionar resultados"
                  onDrag={(delta) =>
                    setResultsHeight((current) => {
                      const next = clampResults(current - delta, sqlStageRef.current);
                      window.localStorage.setItem("gridl.results", String(next));
                      return next;
                    })
                  }
                />
                <div className="query-results" style={{ height: resultsHeight }}>
                  {sqlView.error ? (
                    <ErrorPanel error={sqlView.error} />
                  ) : sqlView.columns.length > 0 ? (
                    <ResultGrid
                      columns={sqlView.columns}
                      rowCount={sqlView.rowCount}
                      rowsRef={rowsHandle(sqlTabId)}
                      onFocusRow={(row) => setFocusedRow(row === null ? null : { tab: sqlTabId, row })}
                      onCellMenu={(row, column, point, range) => setCellMenu({ tab: sqlTabId, row, column, ...point, range })}
                    />
                  ) : (
                    <ResultMessage text={sqlView.pending ? "Ejecutando…" : sqlView.status} />
                  )}
                </div>
              </>
            ) : null}
            <div className={sqlView.error ? "editor-status failed" : "editor-status"}>
              <span>{sqlView.status || "Ejecuta una consulta o elige una tabla."}</span>
            </div>
          </div>
          {activeTable && tableView ? (
            <div className="results-stage">
              <div className="editor-toolbar">
                <div className="toolbar-title">
                  <span>{activeTable.table.schema ? `${activeTable.table.schema}.${activeTable.table.name}` : activeTable.table.name}</span>
                  {structureTable && !structureLocked ? (
                    <div className="view-switch" role="tablist">
                      <button type="button" className={tablePane === "rows" ? "active" : undefined} onClick={() => setTablePane("rows")}>Datos</button>
                      <button type="button" className={tablePane === "structure" ? "active" : undefined} onClick={() => setTablePane("structure")}>Estructura</button>
                    </div>
                  ) : null}
                </div>
                {showsRows(activeTable.table) && tablePane === "rows" ? (
                  <div>
                    <FilterToggle
                      count={(tableQueries[activeTable.id]?.filters ?? []).filter((filter) => filter.enabled).length}
                      open={Boolean(filterOpen[activeTable.id])}
                      onToggle={() => {
                        const id = activeTable.id;
                        const opening = !filterOpen[id];
                        setFilterOpen((current) => ({ ...current, [id]: opening }));
                        if (opening && !(filterDrafts[id]?.length)) {
                          const applied = tableQueries[id]?.filters ?? [];
                          const first = tableView.columns[0]?.name ?? activeTable.table.columns[0]?.name ?? "";
                          setFilterDrafts((current) => ({
                            ...current,
                            [id]: applied.length > 0 ? applied : [{ id: crypto.randomUUID(), column: first, op: "=", value: "", enabled: true }],
                          }));
                        }
                      }}
                    />
                    <ExportMenu disabled={running || tableView.columns.length === 0} onExport={(format) => void exportResult(activeTable.id, format)} />
                    <button type="button" className="toolbar-button" disabled={!writable || running || tableView.columns.length === 0} onClick={startDraft}>
                      <Plus size={14} /> Fila
                    </button>
                    <button type="button" className="toolbar-button" disabled={!writable || running || pickedRows.length === 0} onClick={() => markRows(pickedRows)}>
                      <Trash2 size={14} /> Eliminar
                    </button>
                    {pending[activeTable.id] || stashes[activeTable.id]?.length ? (
                      <>
                        <button type="button" className="toolbar-button" disabled={running} onClick={previewEdits}>
                          <Eye size={14} /> SQL
                        </button>
                        <button type="button" className="run-button" disabled={running} onClick={() => void saveEdits()}>
                          Guardar <kbd>{saveShortcut}</kbd>
                        </button>
                        <button type="button" className="toolbar-button" disabled={running} onClick={discardEdits}>
                          Cancelar
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : showsRows(activeTable.table) ? null : (
                  <span>{kindLabel(activeTable.table.kind)}</span>
                )}
              </div>
              {showsRows(activeTable.table) && tablePane === "rows" && filterOpen[activeTable.id] ? (
                <FilterBar
                  columns={tableView.columns.length > 0 ? tableView.columns : activeTable.table.columns}
                  filters={filterDrafts[activeTable.id] ?? []}
                  busy={running}
                  onChange={(next) => setFilterDrafts((current) => ({ ...current, [activeTable.id]: next }))}
                  onApply={(next) => applyFilters(activeTable.table, next)}
                />
              ) : null}
              {structureTable && !structureLocked ? (
                <div className={tablePane === "structure" ? "structure-stage" : "pane-off"}>
                  <StructureEditor
                    key={structureKey(structureTable)}
                    table={structureTable}
                    engine={engine}
                    busy={running}
                    error={formError}
                    onApply={saveStructure}
                    draft={structureDrafts[tableTabId(structureTable)]?.signature === structureKey(structureTable) ? structureDrafts[tableTabId(structureTable)]?.rows : null}
                    onDraftChange={(rows) => {
                      const id = tableTabId(structureTable);
                      const signature = structureKey(structureTable);
                      setStructureDrafts((current) => {
                        if (rows) return { ...current, [id]: { signature, rows } };
                        if (!(id in current)) return current;
                        const next = { ...current };
                        delete next[id];
                        return next;
                      });
                    }}
                  />
                  <RelationsPanel
                    engine={engine}
                    table={structureTable}
                    tables={tables}
                    keys={foreignKeys}
                    busy={running}
                    editable={!structureLocked}
                    onApply={(statements) => void saveStructure(statements)}
                    onOpenTable={openTableNamed}
                  />
                </div>
              ) : null}
              {tablePane === "structure" && structureTable && !structureLocked ? null : showsRows(activeTable.table) ? (
                tableView.columns.length > 0 ? (
                  <ResultGrid
                    columns={tableView.columns}
                    rowCount={tableView.rowCount}
                    rowsRef={rowsHandle(activeTable.id)}
                    selectable={writable}
                    inserts={pending[activeTable.id]?.inserts ?? []}
                    removed={pending[activeTable.id]?.removed ?? []}
                    edits={pending[activeTable.id]?.edits}
                    onEditInsert={writable ? editInsert : undefined}
                    onEditCell={writable ? editCell : undefined}
                    onInteract={writable ? () => pinTable(activeTable.id) : undefined}
                    onSelectRows={(rows) => setPickedRows(rows.filter((row) => row < tableView.rowCount))}
                    onPasteRows={writable ? pasteRows : undefined}
                    onMarkRows={writable ? markRows : undefined}
                    onDropInserts={writable ? dropInserts : undefined}
                    onFocusRow={(row) => setFocusedRow(row === null ? null : { tab: activeTable.id, row })}
                    sort={tableQueries[activeTable.id]?.sort ?? null}
                    linkedColumns={outgoingKeys(foreignKeys, activeTable.table).flatMap((key) => key.columns)}
                    onSort={(column) => sortBy(activeTable.table, column)}
                    onCellMenu={(row, column, point, range) => setCellMenu({ tab: activeTable.id, row, column, ...point, range })}
                  />
                ) : (
                  tableView.error ? <ErrorPanel error={tableView.error} /> : <div className="results-empty">{tableView.status || "Cargando…"}</div>
                )
              ) : (
                <pre className="definition-view">{activeTable.table.definition || "Sin definición."}</pre>
              )}
              {tablePane === "structure" && structureTable && !structureLocked ? null : !writable && showsRows(activeTable.table) ? (
                <div className="editor-status">
                  <span>{active?.readOnly ? "Conexión de solo lectura." : safety.writes === "block" ? `La política de ${environmentLabel(safety.environment)} bloquea los cambios de datos.` : activeTable.table.kind !== "table" ? "Las vistas no se editan desde aquí." : "Sin clave primaria no se puede editar ni borrar."}</span>
                </div>
              ) : null}
              {tablePane === "structure" && structureTable && !structureLocked ? null : showsRows(activeTable.table) ? (
                <>
                  <TablePager
                    page={paging[activeTable.id]}
                    running={running}
                    onPage={(page) => void loadTable(activeTable.table, page, paging[activeTable.id]?.pageSize ?? 100)}
                    onPageSize={(pageSize) => void loadTable(activeTable.table, 0, pageSize)}
                    onCancel={() => {
                      const queryId = activeQuery.current;
                      if (queryId) void cancelQuery(queryId);
                    }}
                  />
                  {formError || (tableView.error && tableView.columns.length > 0) ? (
                    <ErrorPanel
                      compact
                      error={formError ? describeError(formError, null, engine) : (tableView.error ?? { message: "", hint: null })}
                      onClose={() => {
                        setFormError(null);
                        setViews((current) => ({ ...current, [activeTable.id]: { ...tableView, error: null } }));
                      }}
                    />
                  ) : null}
                  <div className="editor-status">
                    <span>{describeTabChanges(pending[activeTable.id], stashes[activeTable.id] ?? []) || tableView.status}</span>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </main>
        <PaneSplitter
          label="Redimensionar detalles"
          onDrag={(delta) =>
            setDetailsWidth((current) => {
              const next = clampPane(current - delta, 200, paneLimit(workspaceRef.current, explorerOpen ? explorerWidth : 0));
              window.localStorage.setItem("gridl.details", String(next));
              return next;
            })
          }
        />
        <aside className="details-panel">
          <div className="details-heading">
            {focusedValues !== null && detailTable ? (
              <div className="view-switch" role="tablist">
                <button type="button" className={showRow ? "active" : undefined} onClick={() => setDetailsTab("row")}>Fila</button>
                <button type="button" className={showRow ? undefined : "active"} onClick={() => setDetailsTab("structure")}>
                  {detailTable.kind === "function" || detailTable.kind === "procedure" ? "Argumentos" : "Estructura"}
                </button>
              </div>
            ) : (
              <span>{focusedValues !== null ? "Fila" : detailTable && (detailTable.kind === "function" || detailTable.kind === "procedure") ? "Argumentos" : "Estructura"}</span>
            )}
          </div>
          {showRow && focusedRow && focusView ? (
            <RowDetails
              columns={focusView.columns}
              row={focusedValues}
              index={focusedRow.row}
              relation={(column) => {
                const source = activeTable?.table;
                if (!source || focusedRow.tab === sqlTabId) return null;
                const key = keyForColumn(foreignKeys, source, column);
                if (!key || !findTable(tables, key.refSchema, key.refTable)) return null;
                return { label: key.refTable, open: () => openReferenced(key, focusView.columns, focusedValues) };
              }}
            />
          ) : detailTable ? (
            <div className="details-body">
              <strong>{detailTable.schema ? `${detailTable.schema}.${detailTable.name}` : detailTable.name}</strong>
              <span>{detailTable.kind}{primaryKeys(detailTable).length > 0 ? ` · clave ${primaryKeys(detailTable).map((column) => column.name).join(", ")}` : " · sin clave primaria"}</span>
              <ul className="column-list">
                {detailTable.columns.map((column) => (
                  <li key={column.name}>
                    <span>{column.name}{column.primaryKey ? " · pk" : ""}</span>
                    <span title={(column.options ?? []).join(", ") || undefined}>{column.dataType}{(column.options ?? []).length > 0 ? ` · ${column.options.join(", ")}` : ""}</span>
                  </li>
                ))}
              </ul>
              {detailTable.kind === "table" && (outgoingKeys(foreignKeys, detailTable).length > 0 || incomingKeys(foreignKeys, detailTable).length > 0) ? (
                <>
                  <span className="details-subhead">Relaciones</span>
                  <ul className="column-list relation-list">
                    {outgoingKeys(foreignKeys, detailTable).map((key) => (
                      <li key={`out:${key.name}`}>
                        <span>{key.columns.join(", ")}</span>
                        <button type="button" className="relation-link" onClick={() => openTableNamed(key.refSchema, key.refTable)}>→ {refLabel(key, tables)}</button>
                      </li>
                    ))}
                    {incomingKeys(foreignKeys, detailTable).map((key) => (
                      <li key={`in:${key.table}:${key.name}`}>
                        <button type="button" className="relation-link" onClick={() => openTableNamed(key.schema, key.table)}>← {key.table}</button>
                        <span>{key.columns.join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : (
            <div className="details-empty">
              <div className="details-orb">
                <Database size={22} />
              </div>
              <strong>Selecciona un objeto</strong>
              <span>Elige una tabla del explorador para ver sus columnas.</span>
            </div>
          )}
        </aside>
      </div>
      {dialog?.kind === "create-schema" ? (
        <NameDialog title="Nuevo esquema" description="El esquema queda vacío hasta que crees una tabla dentro." initial="" confirmLabel="Crear" busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name) => void submitName(name)} />
      ) : null}
      {dialog?.kind === "rename-schema" ? (
        <NameDialog title="Renombrar esquema" description={`El esquema ${dialog.name} cambia de nombre. Las tablas que contiene se mueven con él.`} initial={dialog.name} confirmLabel="Renombrar" busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name) => void submitName(name)} />
      ) : null}
      {dialog?.kind === "drop-schema" ? (
        <ConfirmDialog title="Eliminar esquema" description={`Se elimina ${dialog.name} solo si no tiene tablas.`} confirmLabel="Eliminar" busy={running} error={formError} onClose={() => setDialog(null)} onConfirm={() => void submitDropSchema()} />
      ) : null}
      {discardAsk ? (
        <UnsavedDialog items={discardAsk.items} action={discardAsk.action} onCancel={() => answerDiscard(false)} onDiscard={() => answerDiscard(true)} />
      ) : null}
      {guardAsk ? (
        <GuardDialog
          info={guardAsk.info}
          database={active?.database ?? ""}
          many={guardAsk.many}
          onCancel={() => answerGuard(false)}
          onConfirm={() => answerGuard(true)}
        />
      ) : null}
      {cellMenu ? <ContextMenu x={cellMenu.x} y={cellMenu.y} items={cellMenuItems(cellMenu)} onClose={() => setCellMenu(null)} /> : null}
      {preview ? (
        <PreviewDialog statements={preview} busy={running} error={formError} onClose={() => setPreview(null)} onApply={() => void saveEdits()} />
      ) : null}
      {dialog?.kind === "create-table" ? (
        <TableDialog engine={engine} schema={engine === "postgres" ? activeSchema : null} tables={tables} busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name, columns) => void submitTable(name, columns)} />
      ) : null}
    </div>
  );
}

function describePending(edit: PendingChanges | undefined): string {
  if (!edit) return "";
  const parts: string[] = [];
  const changed = Object.keys(edit.edits ?? {}).length;
  if (changed === 1) parts.push("1 fila modificada");
  else if (changed > 1) parts.push(`${changed} filas modificadas`);
  if (edit.inserts.length === 1) parts.push("1 fila nueva");
  else if (edit.inserts.length > 1) parts.push(`${edit.inserts.length} filas nuevas`);
  if (edit.removed.length === 1) parts.push("1 fila por borrar");
  else if (edit.removed.length > 1) parts.push(`${edit.removed.length} filas por borrar`);
  return parts.length > 0 ? `${parts.join(", ")}. Guarda para aplicar.` : "";
}

/** Status text for a tab's pending edits, counting the ones kept on other pages. */
function describeTabChanges(edit: PendingChanges | undefined, others: PageStash[]): string {
  const here = describePending(edit);
  if (others.length === 0) return here;
  const pages = others.length === 1 ? "1 página más" : `${others.length} páginas más`;
  const prefix = here ? here.replace(/\. Guarda para aplicar\.$/, "") + ". " : "";
  return `${prefix}También hay cambios en ${pages}. Guarda para aplicar todo.`;
}

function pastedValue(text: string, column: ColumnDefinition): SqlValue {
  const trimmed = text.trim();
  if (trimmed === "") return { t: "null" };
  if (isTemporalColumn(column)) {
    const marker = canonicalTemporal(trimmed);
    if (marker === "null") return { t: "text", v: "null" };
    if (marker) return { t: "text", v: marker };
    return { t: "text", v: text };
  }
  if (trimmed.toUpperCase() === "NULL") return { t: "null" };
  return { t: "text", v: text };
}

function pastedRow(columns: ColumnDefinition[], cells: readonly string[], startColumn: number): SqlValue[] {
  const origin = cells.length === columns.length ? 0 : Math.max(0, startColumn);
  return columns.map((column, index) => {
    if (isGeneratedColumn(column)) return { t: "null" };
    const offset = index - origin;
    if (offset < 0 || offset >= cells.length) return { t: "null" };
    return pastedValue(cells[offset] ?? "", column);
  });
}

function isHeaderRow(cells: readonly string[], columns: ColumnDefinition[]): boolean {
  if (cells.length === 0 || columns.length === 0) return false;
  return cells.every((cell, index) => {
    const name = columns[index]?.name;
    return Boolean(name) && cell.trim().toLowerCase() === name.toLowerCase();
  });
}

function mergeColumns(columns: ColumnDefinition[], table: TableSchema): ColumnDefinition[] {
  return columns.map((column) => {
    const catalog = table.columns.find((item) => item.name === column.name);
    if (!catalog) return column;
    return {
      ...column,
      nullable: catalog.nullable,
      defaultValue: catalog.defaultValue,
      options: (catalog.options ?? []).length > 0 ? catalog.options : (column.options ?? []),
      dataType: (catalog.options ?? []).length > 0 ? catalog.dataType : column.dataType,
    };
  });
}

function structureKey(table: TableSchema): string {
  const columns = table.columns.map((column) => `${column.name}:${column.dataType}:${column.nullable}:${column.defaultValue ?? ""}:${column.primaryKey}:${(column.options ?? []).join(",")}`).join("|");
  return `${table.schema ?? ""}.${table.name}:${columns}`;
}

function sameDisplayedRow(left: SqlValue[], right: SqlValue[]): boolean {
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const current = left[index];
    const original = right[index];
    const currentText = !current || current.t === "null" ? "" : formatSqlValue(current);
    const originalText = !original || original.t === "null" ? "" : formatSqlValue(original);
    if (currentText !== originalText) return false;
  }
  return true;
}

function fieldsFromValues(columns: ColumnDefinition[], values: SqlValue[]): Record<string, CellField> {
  const fields: Record<string, CellField> = {};
  columns.forEach((column, index) => {
    const value = values[index];
    if (!value || value.t === "null") fields[column.name] = { text: "", isNull: true };
    else fields[column.name] = { text: formatSqlValue(value), isNull: false };
  });
  return fields;
}

function fieldsFromDraft(table: TableSchema, columns: ColumnDefinition[], values: SqlValue[]): Record<string, CellField> {
  const fields: Record<string, CellField> = {};
  for (const column of table.columns) {
    if (isGeneratedColumn(column)) continue;
    const index = columns.findIndex((item) => item.name === column.name);
    const value = index >= 0 ? values[index] : undefined;
    if (!value || value.t === "null" || value.t === "bytes") {
      fields[column.name] = { text: "", isNull: true };
    } else if (value.t === "bool") {
      fields[column.name] = { text: value.v ? "true" : "false", isNull: false };
    } else {
      fields[column.name] = { text: value.t === "text" ? value.v : formatSqlValue(value), isNull: false };
    }
  }
  return fields;
}

function namesFromTables(list: TableSchema[]): string[] {
  const names = new Set<string>();
  for (const table of list) {
    if (table.schema) names.add(table.schema);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function readSchemas(connectionId: string): Promise<string[]> {
  const names: string[] = [];
  await executeQuery(
    { connectionId, queryId: crypto.randomUUID(), sql: listSchemasSql(), params: [], chunkRows: 200 },
    (chunk) => {
      for (const row of chunk.rows) {
        const name = schemaNameFrom(row[0]);
        if (name) names.push(name);
      }
    },
  );
  return names;
}

type SavedTab = {
  schema: string | null;
  name: string;
  kind: TableSchema["kind"];
  pinned: boolean;
};

type SavedSession = {
  sql: string;
  activeTab: string;
  tabs: SavedTab[];
};

function sessionKey(id: string) {
  return `gridl.session.${id}`;
}

function workspaceTabs(tabs: TableTab[]): SavedTab[] {
  return tabs.map((tab) => ({
    schema: tab.table.schema,
    name: tab.table.name,
    kind: tab.table.kind,
    pinned: tab.pinned,
  }));
}

function readSession(id: string): SavedSession | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (!parsed || typeof parsed.sql !== "string" || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.flatMap((tab) => {
      if (!tab || typeof tab !== "object") return [];
      const item = tab as Partial<SavedTab>;
      if (typeof item.name !== "string" || typeof item.kind !== "string") return [];
      return [{
        schema: typeof item.schema === "string" ? item.schema : null,
        name: item.name,
        kind: item.kind as TableSchema["kind"],
        pinned: item.pinned !== false,
      }];
    });
    return {
      sql: parsed.sql,
      activeTab: typeof parsed.activeTab === "string" ? parsed.activeTab : sqlTabId,
      tabs,
    };
  } catch {
    return null;
  }
}

function writeSession(id: string, session: SavedSession) {
  try {
    const sql = session.sql.length > 500_000 ? session.sql.slice(0, 500_000) : session.sql;
    window.localStorage.setItem(sessionKey(id), JSON.stringify({ ...session, sql }));
  } catch {
    // The browser can reject the write when storage is full.
  }
}

function matchTabs(saved: SavedSession | null, tables: TableSchema[]): TableTab[] {
  if (!saved) return [];
  const tabs: TableTab[] = [];
  for (const item of saved.tabs) {
    const table = tables.find((candidate) => candidate.name === item.name && (candidate.schema ?? null) === item.schema && candidate.kind === item.kind);
    if (!table) continue;
    const id = tableTabId(table);
    if (tabs.some((tab) => tab.id === id)) continue;
    tabs.push({ id, table, pinned: item.pinned });
  }
  return tabs;
}

function readPaneWidth(key: string, fallback: number) {
  const stored = window.localStorage.getItem(key);
  const value = stored === null ? Number.NaN : Number(stored);
  return Number.isFinite(value) && value > 0 ? clampPane(value, 200, 640) : fallback;
}

function readResultsHeight() {
  const stored = window.localStorage.getItem("gridl.results");
  const value = stored === null ? Number.NaN : Number(stored);
  return Number.isFinite(value) && value > 0 ? Math.max(120, value) : 320;
}

function clampResults(value: number, stage: HTMLDivElement | null) {
  const total = stage?.clientHeight ?? 720;
  const max = Math.max(120, total - 180);
  return Math.min(Math.max(value, 120), max);
}

function clampPane(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function paneLimit(body: HTMLDivElement | null, other: number) {
  const total = body?.clientWidth ?? 1100;
  return total - other - 420;
}

function PaneSplitter({ label, axis = "x", onDrag }: { label: string; axis?: "x" | "y"; onDrag: (delta: number) => void }) {
  const vertical = axis === "y";
  return (
    <div
      className={vertical ? "pane-splitter row" : "pane-splitter"}
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("dragging");
        let last = vertical ? event.clientY : event.clientX;
        const move = (next: PointerEvent) => {
          const point = vertical ? next.clientY : next.clientX;
          onDrag(point - last);
          last = point;
        };
        const stop = () => {
          handle.classList.remove("dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      }}
    />
  );
}

function TablePager({
  page,
  running,
  onPage,
  onPageSize,
  onCancel,
}: {
  page: TablePage | undefined;
  running: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
  onCancel: () => void;
}) {
  const current = page?.page ?? 0;
  const pageSize = page?.pageSize ?? 100;
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min(total, (current + 1) * pageSize);
  return (
    <div className="pager">
      <button type="button" disabled={running || current <= 0} onClick={() => onPage(current - 1)}>
        <ChevronLeft size={14} /> Anterior
      </button>
      <button type="button" disabled={running || current + 1 >= pageCount} onClick={() => onPage(current + 1)}>
        Siguiente <ChevronRight size={14} />
      </button>
      <span>{page ? `${from.toLocaleString("es")}–${to.toLocaleString("es")} de ${total.toLocaleString("es")}` : "Cargando…"}</span>
      <label>
        Filas
        <select value={pageSize} disabled={running} onChange={(event) => onPageSize(Number(event.target.value))}>
          {pageSizes.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>
      {running ? (
        <button type="button" onClick={onCancel}>Cancelar</button>
      ) : null}
    </div>
  );
}

function TreeBranch({
  label,
  open,
  onToggle,
  depth,
  icon,
  active = false,
  actions,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  depth: string;
  icon: ReactNode;
  active?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className={active ? `tree-item schema-row ${depth} active` : `tree-item schema-row ${depth}`}>
        <button type="button" className="tree-toggle" aria-expanded={open} aria-label={open ? `Contraer ${label}` : `Expandir ${label}`} onClick={onToggle}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {icon}
        <button type="button" className="schema-name" onClick={onToggle}>
          <span>{label}</span>
        </button>
        {actions}
      </div>
      {open ? children : null}
    </div>
  );
}

function ObjectIcon({ kind, size }: { kind: TableSchema["kind"]; size: number }) {
  if (kind === "function" || kind === "procedure") return <Braces size={size} />;
  if (kind === "sequence") return <Hash size={size} />;
  if (kind === "trigger") return <Zap size={size} />;
  if (kind === "index") return <ListTree size={size} />;
  return <Table2 size={size} />;
}

function kindLabel(kind: TableSchema["kind"]) {
  return objectGroups.find((group) => group.kind === kind)?.label ?? kind;
}

function TableLeaf({
  table,
  selected,
  className,
  onOpen,
}: {
  table: TableSchema;
  selected: TableSchema | null;
  className: string;
  onOpen: (table: TableSchema, pin?: boolean) => void;
}) {
  const active = selected?.name === table.name && (selected.schema ?? "") === (table.schema ?? "") && selected?.kind === table.kind;
  return (
    <button
      type="button"
      className={active ? `tree-item ${className} active` : `tree-item ${className}`}
      onClick={() => onOpen(table)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpen(table, true);
      }}
    >
      <ObjectIcon kind={table.kind} size={13} /> <span>{table.name}</span>
    </button>
  );
}

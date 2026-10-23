import { open, save } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, ArrowLeft, Braces, Database, Eye, FastForward, Folder, PanelLeft, Pencil, Play, Plus, Search, TerminalSquare, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitStatements } from "./editor/activeSql";
import { SqlEditor, type SqlEditorHandle } from "./editor/SqlEditor";
import { ResultGrid, type GridRangeActions } from "./grid/ResultGrid";
import { ConnectionHome, type HomeCommand } from "./home/ConnectionHome";
import { UpdateCenter } from "./home/UpdateCenter";
import { toConfig, type Draft } from "./home/draft";
import { cancelQuery, connect, createGroup, deleteGroup, deleteProfile, disconnect, errorMessage, checkSql, defaultSafety, executeBatch, GuardError, executeQuery, exportQuery, importCsv, backupDatabase, restoreDatabase, formatSqlValue, introspect, listForeignKeys, listProfiles, closeDiscarding, listenHere, openConnectionWindow, quitDiscarding, setUnsaved, qualifiedName, quoteIdent, saveConnection, setDialect, testConnection, writeExport, type BatchStatement, type BrowseKind, type ColumnDefinition, type ConnectionCatalog, type ConnectionConfig, type DatabaseEngine, type ForeignKey, type GuardInfo, type SqlValue, type TableSchema, type TestResult } from "./lib/api";
import { canEditRows, createSchemaSql, createTableSql, deleteSql, dropSchemaSql, insertSql, listSchemasSql, primaryKeys, renameSchemaSql, rowRecord, schemaNameFrom, updateSql, type ColumnDraft } from "./workspace/changes";
import { describeError, isConnectionLost, type ShownError } from "./lib/errors";
import { ConfirmDialog, NameDialog, TableDialog } from "./workspace/dialogs";
import { exportRows, sqlLiteral, toTsv, type ExportFormat } from "./workspace/export";
import { nextSort, orderClause, whereClause, type TableFilter } from "./workspace/filters";
import { clearHistory, forgetHistory, pushHistory, readHistory, removeHistory, toggleStar, type HistoryEntry } from "./workspace/history";
import { environmentLabel } from "./lib/environments";
import { ContextMenu, ErrorPanel, GuardDialog, UnsavedDialog, ExportMenu, type MenuItem, FilterBar, FilterToggle, HistoryMenu, PreviewDialog, ResultMessage, RowDetails } from "./workspace/panels";
import { ImportDialog, type ImportPlan } from "./workspace/ImportDialog";
import { RelationsPanel } from "./workspace/RelationsPanel";
import { findTable, keyForColumn, outgoingKeys, incomingKeys, refLabel, resolvedRefColumns } from "./workspace/relations";
import { StructureEditor } from "./workspace/StructureEditor";
import { kindLabel, pageSizes, sqlTabId, countValue, clonePending, pendingEmpty, viewKey, viewLabel, primaryKeyList, emptyView, tableTabId, showsRows, objectGroups, schemaMap, describePending, describeTabChanges, pastedRow, isHeaderRow, mergeColumns, structureKey, sameDisplayedRow, fieldsFromValues, fieldsFromDraft, namesFromTables, type TableQuery, type TablePage, type TabView, type TableTab, type PendingChanges, type PageStash, type UndoEntry, type WorkspaceDialog } from "./workspace/model";
import { sessionKey, workspaceTabs, readSession, writeSession, matchTabs, readPaneWidth, readResultsHeight, clampResults, clampPane, paneLimit } from "./workspace/session";
import { PaneSplitter, TablePager, TreeBranch, ObjectIcon, TableLeaf } from "./workspace/chrome";

const emptyCatalog: ConnectionCatalog = { groups: [], profiles: [] };
/** Stable empties so the grid does not repaint because of a fresh `[]`. */
const NO_ROWS: SqlValue[][] = [];
const NO_INDEXES: number[] = [];
/** Rows the editor keeps by default; "Cargar más" raises it step by step. */
const editorRowSteps = [10_000, 100_000, 1_000_000];
/** Statements safe to run again to fetch more rows. */
const rerunnable = /^\s*(select|with|show|explain|values|table|describe|desc|pragma)\b/i;
const modifies = /\b(insert|update|delete|merge|into)\b/i;
const runShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";
const saveShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";
const formatShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘I" : "Ctrl+I";
const runAllShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⇧⌘↵" : "Ctrl+Shift+↵";
const schemaChange = /^\s*(create|alter|drop|rename|comment|truncate)\b/i;

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
  const [reconnecting, setReconnecting] = useState(false);
  const [importing, setImporting] = useState<{ tab: string; table: TableSchema; path: string; busy: boolean; progress: number | null; error: string | null } | null>(null);
  const [backupMenu, setBackupMenu] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const reconnectRef = useRef<() => Promise<boolean>>(async () => false);
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
    void listenHere<string>("gridl-command", (event) => {
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
        if (cancelled) return;
        setCatalog(next);
        // A window opened for one connection carries it in the URL: #connect=<id>.
        const wanted = new URLSearchParams(window.location.hash.slice(1)).get("connect");
        const profile = wanted ? next.profiles.find((item) => item.id === wanted) : undefined;
        if (profile) void openSavedRef.current(profile);
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

  const openSavedRef = useRef<(profile: ConnectionConfig) => Promise<boolean>>(async () => false);
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
      const message = errorMessage(caught);
      // Already open in another window: the shell focused it, nothing to show here.
      if (message.startsWith("gridl-focused:")) return false;
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  openSavedRef.current = openSaved;

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

  /** Opens the session again with the saved profile; the keychain supplies saved passwords. */
  reconnectRef.current = async () => {
    if (!active || reconnecting) return false;
    setReconnecting(true);
    try {
      const response = await connect({ config: active, password: null, rememberPassword: false, sshSecret: null, rememberSshSecret: false, trustSshHost: false });
      setActive(response.config);
      setTables(response.tables);
      setViews((current) => {
        const next = { ...current };
        for (const [id, view] of Object.entries(next)) {
          if (view.error && isConnectionLost(view.error.message)) next[id] = { ...view, error: null, status: "Reconectado" };
        }
        return next;
      });
      setFormError(null);
      return true;
    } catch (caught) {
      setFormError(`No se pudo reconectar: ${errorMessage(caught)}. Si la contraseña no está guardada, vuelve a Conexiones y ábrela de nuevo.`);
      return false;
    } finally {
      setReconnecting(false);
    }
  };
  const reconnectAction = (error: ShownError | null | undefined) =>
    error && isConnectionLost(error.message) ? { label: "Reconectar", busy: reconnecting, run: () => void reconnectRef.current() } : null;

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

  const runQuery = useCallback(async (tabId = sqlTabId, sql?: string | string[], maxRows = editorRowSteps[0]) => {
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
          { connectionId, queryId: thisQuery, sql: statement, params: [], chunkRows: 500, authorized, maxRows },
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
        finalResult.truncated ? `se muestran las primeras ${maxRows.toLocaleString("es")} filas` : null,
      ].filter((note) => note !== null);
      const returnsRows = finalResult.columns.length > 0 || finalResult.rowCount > 0;
      const headline = total > 1
        ? `${total} sentencias · ${returnsRows ? `${finalResult.rowCount} filas en la última` : `${affected} filas afectadas`}`
        : returnsRows ? `${finalResult.rowCount} filas` : `${finalResult.rowsAffected} filas afectadas`;
      const duration = total > 1 ? Math.round(performance.now() - started) : finalResult.durationMs;
      const status = `${headline} · ${duration} ms${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
      const lastStatement = statements[total - 1] ?? "";
      const nextLimit = editorRowSteps.find((step) => step > maxRows);
      const more = finalResult.truncated && nextLimit && rerunnable.test(lastStatement) && !modifies.test(lastStatement)
        ? { sql: lastStatement, limit: nextLimit }
        : null;
      setViews((current) => ({
        ...current,
        [tabId]: {
          columns: finalResult.columns.length > 0 ? finalResult.columns : (current[tabId]?.columns ?? []),
          rowCount: rows.length,
          status,
          error: null,
          pending: false,
          ran: true,
          more,
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

  const loadTable = useCallback(async (table: TableSchema, page: number, pageSize: number, keepPending = false, discard = false, retried = false): Promise<void> => {
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
      // A page load is a read: after a dropped connection, reconnect and try once more.
      if (!retried && isConnectionLost(errorMessage(caught))) {
        if (runningTab.current === id) {
          setRunning(false);
          runningTab.current = null;
        }
        if (await reconnectRef.current()) {
          await loadTable(table, page, pageSize, true, false, true);
          return;
        }
      }
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

  const startImport = async (tabId: string, table: TableSchema) => {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
    if (typeof picked === "string") setImporting({ tab: tabId, table, path: picked, busy: false, progress: null, error: null });
  };

  const runImport = async (plan: ImportPlan) => {
    if (!active || !importing) return;
    const job = importing;
    setImporting({ ...job, busy: true, progress: 0, error: null });
    const stop = await listenHere<{ rows: number }>("gridl-import-progress", (event) => {
      setImporting((current) => (current ? { ...current, progress: event.payload.rows } : current));
    }).catch(() => () => undefined);
    try {
      const done = await guarded((authorized) => importCsv({
        connectionId: active.id,
        path: job.path,
        delimiter: plan.delimiter,
        hasHeader: plan.hasHeader,
        table: qualifiedName(job.table),
        columns: plan.columns,
        mapping: plan.mapping,
        nullToken: plan.nullToken,
        authorized,
      }));
      setImporting(null);
      await reloadOpenTable(job.table);
      setStatus(job.tab, `${done.rows.toLocaleString("es")} filas importadas · ${done.durationMs} ms`);
    } catch (caught) {
      setImporting((current) => (current ? { ...current, busy: false, progress: null, error: errorMessage(caught) } : current));
    } finally {
      stop();
    }
  };

  const runBackup = async () => {
    if (!active) return;
    setBackupMenu(false);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const base = (active.engine === "sqlite" ? active.database.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") : active.database) || "respaldo";
    const extension = active.engine === "sqlite" ? "sqlite" : "sql";
    const path = await save({ defaultPath: `${base}-${stamp}.${extension}`, filters: [{ name: "Respaldo", extensions: [extension] }] });
    if (!path) return;
    setBackupNote("Creando respaldo…");
    try {
      const done = await backupDatabase({ connectionId: active.id, path, password: null });
      const size = done.bytes > 1_048_576 ? `${(done.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(done.bytes / 1024))} KB`;
      setBackupNote(`Respaldo listo: ${done.path} (${size}, ${(done.durationMs / 1000).toFixed(1)} s)`);
    } catch (caught) {
      setBackupNote(`No se pudo crear el respaldo: ${errorMessage(caught)}`);
    }
  };

  const runRestore = async () => {
    if (!active) return;
    setBackupMenu(false);
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "SQL", extensions: ["sql", "dump"] }] });
    if (typeof picked !== "string") return;
    setBackupNote("Restaurando…");
    try {
      const done = await guarded((authorized) => restoreDatabase({ connectionId: active.id, path: picked, password: null, authorized }));
      setBackupNote(`Restauración terminada en ${(done.durationMs / 1000).toFixed(1)} s`);
      await refreshSchema();
    } catch (caught) {
      setBackupNote(`No se pudo restaurar: ${errorMessage(caught)}`);
    }
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
      if (table) {
        // The whole table goes from the database to the file in Rust; the UI never holds the rows.
        setStatus(tabId, "Exportando…");
        const query = tableQueryRef.current[tabId];
        const queryId = crypto.randomUUID();
        const stop = await listenHere<{ queryId: string; rows: number }>("gridl-export-progress", (event) => {
          if (event.payload.queryId === queryId) setStatus(tabId, `Exportando… ${event.payload.rows.toLocaleString("es")} filas`);
        }).catch(() => () => undefined);
        try {
          const done = await guarded((authorized) => exportQuery({
            connectionId: active.id,
            queryId,
            sql: `select * from ${qualifiedName(table)}${whereClause(query?.filters ?? [], engine)}${orderClause(table, query?.sort ?? null)}`,
            format,
            path,
            table: qualifiedName(table),
            authorized,
          }));
          const size = done.bytes > 1_048_576 ? `${(done.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(done.bytes / 1024))} KB`;
          setStatus(tabId, `${done.rows.toLocaleString("es")} filas exportadas (${size}) a ${path}`);
        } finally {
          stop();
        }
        return;
      }
      const columns = views[sqlTabId]?.columns ?? [];
      const rows = rowsByTab.current[sqlTabId] ?? [];
      await writeExport(path, exportRows(format, columns, rows, engine, quoteIdent("resultado")));
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
    void listenHere<"window" | "app">("gridl-close-requested", (event) => {
      const quitting = event.payload === "app";
      void confirmDiscardRef.current({ action: quitting ? "Salir de Gridl" : "Cerrar la ventana" }).then((ok) => {
        if (!ok) return;
        void (quitting ? quitDiscarding() : closeDiscarding());
      });
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, []);

  const updates = <UpdateCenter beforeRestart={() => confirmDiscardRef.current({ action: "Actualizar y reiniciar" })} />;

  if (screen === "home") {
    return (
      <>
      <ConnectionHome
        catalog={catalog}
        busy={busy}
        error={error}
        onCreateGroup={addGroup}
        onDeleteGroup={removeGroup}
        onDeleteConnection={removeConnection}
        onOpen={openSaved}
        onOpenWindow={(profile) => {
          void openConnectionWindow(profile.id).catch((caught: unknown) => setError(errorMessage(caught)));
        }}
        onSave={saveDraft}
        onBrowse={browse}
        onTest={testDraft}
        pendingCommand={homeCommand}
      />
      {updates}
      </>
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
        <div className="topbar-actions">
          {backupNote ? (
            <span className="backup-note" title={backupNote} onClick={() => setBackupNote(null)}>{backupNote}</span>
          ) : null}
          <div className="popover-anchor">
            <button type="button" className="toolbar-button" onClick={() => setBackupMenu((current) => !current)}>
              <ArchiveRestore size={14} /> Respaldo
            </button>
            {backupMenu ? (
              <div className="popover-menu" onMouseLeave={() => setBackupMenu(false)}>
                <button type="button" onClick={() => void runBackup()}>Crear respaldo…</button>
                <button type="button" disabled={active?.engine === "sqlite" || structureLocked} onClick={() => void runRestore()}>Restaurar desde archivo…</button>
              </div>
            ) : null}
          </div>
        </div>
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
                    <ErrorPanel error={sqlView.error} action={reconnectAction(sqlView.error)} />
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
              {sqlView.more && !running ? (
                <button
                  type="button"
                  className="status-action"
                  title="Vuelve a ejecutar la consulta trayendo más filas"
                  onClick={() => {
                    const more = sqlView.more;
                    if (more) void runQuery(sqlTabId, more.sql, more.limit);
                  }}
                >
                  Cargar hasta {sqlView.more.limit.toLocaleString("es")} filas
                </button>
              ) : null}
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
                    {writable ? (
                      <button type="button" className="toolbar-button" disabled={running} title="Importar filas desde un archivo CSV" onClick={() => void startImport(activeTable.id, activeTable.table)}>
                        <Upload size={14} /> Importar
                      </button>
                    ) : null}
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
                    inserts={pending[activeTable.id]?.inserts ?? NO_ROWS}
                    removed={pending[activeTable.id]?.removed ?? NO_INDEXES}
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
                  tableView.error ? <ErrorPanel error={tableView.error} action={reconnectAction(tableView.error)} /> : <div className="results-empty">{tableView.status || "Cargando…"}</div>
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
      {updates}
      {importing ? (
        <ImportDialog
          path={importing.path}
          table={importing.table}
          busy={importing.busy}
          progress={importing.progress}
          error={importing.error}
          onClose={() => setImporting(null)}
          onImport={(plan) => void runImport(plan)}
        />
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

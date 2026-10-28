import { engineSpec } from "./engines";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, ArrowLeft, Bookmark, Braces, CircleStop, FileCode, GitCompareArrows, Link2, Network, Route, Undo2, Database, Eye, FastForward, Folder, PanelLeft, Pencil, Play, Plus, Search, TerminalSquare, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commandTag, splitStatements, withoutComments } from "./editor/activeSql";
import { SqlDefinition } from "./editor/SqlDefinition";
import { SqlEditor, type SqlEditorHandle } from "./editor/SqlEditor";
import { editorFailure } from "./editor/failure";
import { recordError } from "./lib/errorLog";
import { ResultGrid, type GridRangeActions } from "./grid/ResultGrid";
import type { ConnectingState } from "./home/ConnectingStatus";
import { ConnectionHome, type HomeCommand } from "./home/ConnectionHome";
import { UpdateCenter } from "./home/UpdateCenter";
import { toConfig, type Draft } from "./home/draft";
import { cancelQuery, connect, createGroup, deleteGroup, deleteProfile, disconnect, errorMessage, checkSql, defaultSafety, executeBatch, GuardError, executeQuery, exportQuery, importCsv, backupDatabase, restoreDatabase, formatSqlValue, introspect, describeRelation, tableObjects, listForeignKeys, listProfiles, closeDiscarding, listenHere, openConnectionWindow, openHomeWindow, emptyTeam, teamState, teamLink, teamShare, teamUnshare, teamSaveQueries, type TeamState, quitDiscarding, setUnsaved, qualifiedName, quoteIdent, saveConnection, setDialect, testConnection, writeExport, type BatchStatement, type BrowseKind, type ColumnDefinition, type ConnectionCatalog, type ConnectionConfig, type DatabaseEngine, type ForeignKey, type GuardInfo, type SqlValue, type TableSchema, type TestResult } from "./lib/api";
import { canEditRows, createSchemaSql, createTableSql, deleteSql, dropSchemaSql, insertSql, listSchemasSql, renameSchemaSql, routineCallSql, rowRecord, schemaNameFrom, updateSql, type ColumnDraft } from "./workspace/changes";
import { CodedError, describeError, errorCode, isConnectionLost, type ShownError } from "./lib/errors";
import { formatNumber, formatTime, plural, t } from "./lib/i18n";
import { ConfirmDialog, NameDialog, TableDialog } from "./workspace/dialogs";
import { exportRows, toJson, sqlLiteral, toTsv, type ExportFormat } from "./workspace/export";
import { nextSort, orderClause, pageClause, whereClause, type TableFilter } from "./workspace/filters";
import { clearHistory, forgetHistory, pushHistory, readHistory, removeHistory, toggleStar, type HistoryEntry } from "./workspace/history";
import { environmentLabel } from "./lib/environments";
import { ContextMenu, CopyButton, ErrorPanel, GuardDialog, UnsavedDialog, ExportMenu, type MenuItem, FilterBar, FilterToggle, HistoryMenu, PreviewDialog, ResultMessage, RoutineSummary, RowDetails } from "./workspace/panels";
import { ImportDialog, type ImportPlan } from "./workspace/ImportDialog";
import { RelationsPanel } from "./workspace/RelationsPanel";
import { findTable, keyForColumn, outgoingKeys, resolvedRefColumns } from "./workspace/relations";
import { readSaved, removeSaved, saveQuery, suggestedName, withSaved, type SavedQuery } from "./workspace/saved";
import { explainSql, parsePlan } from "./workspace/plan";
import { PlanView } from "./workspace/PlanView";
import { readTableState, writeTableStates } from "./workspace/tableState";
import { bindParams, findParams } from "./editor/params";
import { ParamsDialog } from "./workspace/ParamsDialog";
import { linkTarget, parseLink, shareLink, type OpenLink } from "./workspace/links";
import { ErDiagram } from "./workspace/ErDiagram";
import { CompareView } from "./workspace/CompareView";
import { QuickOpen } from "./workspace/QuickOpen";
import { LogoLoader } from "./workspace/LogoLoader";
import { hideSplash } from "./splash";
import { ConnectionSwitcher } from "./workspace/ConnectionSwitcher";
import { SchemaPicker } from "./workspace/SchemaPicker";
import { StructureEditor } from "./workspace/StructureEditor";
import { isSqlTab, kindLabel, largeTableRows, nextSqlTabId, pageSizes, pageStatus, rowEstimateSql, sqlTabId, sqlTabNumber, countValue, clonePending, pendingEmpty, viewKey, viewLabel, primaryKeyList, emptyView, tableTabId, showsRows, objectGroups, schemaMap, describeTabChanges, pendingSummary, pastedRow, isHeaderRow, mergeColumns, structureKey, sameDisplayedRow, fieldsFromValues, fieldsFromDraft, namesFromTables, keepDefinition, withTable, scriptResultLabel, scriptWriteSummary, type ScriptResult, type TableQuery, type TablePage, type TabView, type TableTab, type PendingChanges, type PageStash, type UndoEntry, type WorkspaceDialog } from "./workspace/model";
import { sessionKey, workspaceTabs, readSession, writeSession, readSchemaView, writeSchemaView, matchTabs, readPaneWidth, readResultsHeight, clampResults, clampPane, paneLimit } from "./workspace/session";
import { PaneSplitter, TablePager, TreeBranch, ObjectIcon, TableLeaf } from "./workspace/chrome";

const emptyCatalog: ConnectionCatalog = { groups: [], profiles: [] };
/** Stable empties so the grid does not repaint because of a fresh `[]`. */
const NO_ROWS: SqlValue[][] = [];
const NO_INDEXES: number[] = [];
/** Rows the editor keeps by default; "Load up to" raises it step by step. */
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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [paramPrompt, setParamPrompt] = useState<{ tabId: string; statements: string[]; maxRows: number; names: string[] } | null>(null);
  const [localQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [team, setTeam] = useState<TeamState>(emptyTeam);
  const teamRef = useRef(team);
  teamRef.current = team;
  const [active, setActive] = useState<ConnectionConfig | null>(null);
  /** Saved queries of a team connection live in the team file; the others stay on this Mac. */
  const sharedConnection = Boolean(active && team.connections.some((profile) => profile.id === active.id));
  const savedQueries = useMemo(
    () => (active && sharedConnection ? (team.queries[active.id] ?? []) : localQueries),
    [active, localQueries, sharedConnection, team.queries],
  );
  const savedQueriesRef = useRef(savedQueries);
  savedQueriesRef.current = savedQueries;
  const [tables, setTables] = useState<TableSchema[]>([]);
  /** The workspace is open and the catalog is still being read. */
  const [schemaLoading, setSchemaLoading] = useState(false);
  /** Bumped when a deferred schema arrives, so the tabs it restores load their rows. */
  const [schemaArrived, setSchemaArrived] = useState(0);
  /** Tells a schema that arrives late from one for the current session. */
  const schemaEpoch = useRef(0);
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([]);
  const [tableTabs, setTableTabs] = useState<TableTab[]>([]);
  const [paging, setPaging] = useState<Record<string, TablePage>>({});
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  /** Latest load of each table tab; a count that finishes after a newer load is dropped. */
  const loadToken = useRef<Record<string, number>>({});
  /** Row count running in the background for each table tab. */
  const countQuery = useRef<Record<string, string>>({});
  const [schemaChoice, setSchemaChoice] = useState("public");
  /** Postgres only: show every schema as a tree instead of the one picked above it. */
  const [allSchemas, setAllSchemas] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dbSchemas, setDbSchemas] = useState<string[]>([]);
  const [pickedRows, setPickedRows] = useState<number[]>([]);
  const [pending, setPending] = useState<Record<string, PendingChanges>>({});
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState(sqlTabId);
  /** Open SQL editor tabs, in order. */
  const [sqlTabs, setSqlTabs] = useState<string[]>([sqlTabId]);
  const sqlTabsRef = useRef(sqlTabs);
  sqlTabsRef.current = sqlTabs;
  const sqlTabLabel = (id: string) =>
    sqlMeta[id]?.title || (sqlTabNumber(id) === 1 ? t("app.tabs.sqlEditor") : `${t("app.tabs.sqlEditor")} ${sqlTabNumber(id)}`);
  /** Text each SQL tab's editor starts with when it mounts. */
  const sqlSeeds = useRef<Record<string, string>>({});
  /** Names of SQL tabs and the saved query each one holds, when it holds one. */
  const [sqlMeta, setSqlMeta] = useState<Record<string, { title?: string; savedId?: string }>>({});
  const sqlMetaRef = useRef(sqlMeta);
  sqlMetaRef.current = sqlMeta;
  /** Tabs whose text no longer matches the saved query they were opened from. */
  const [sqlDirty, setSqlDirty] = useState<Record<string, boolean>>({});
  const [tablePane, setTablePane] = useState<"rows" | "structure">("rows");
  const [views, setViews] = useState<Record<string, TabView>>({
    [sqlTabId]: emptyView(t("app.empty.start")),
  });
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  /** Bumped by every connect and by Cancel, so a late answer knows it was abandoned. */
  const connectAttempt = useRef(0);
  /** The last attempt per connection, including a cancelled one's cleanup, so two never overlap. */
  const connectTail = useRef(new Map<string, Promise<unknown>>());
  const [filterDrafts, setFilterDrafts] = useState<Record<string, TableFilter[]>>({});
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const [tableQueries, setTableQueries] = useState<Record<string, TableQuery>>({});
  const tableQueryRef = useRef<Record<string, TableQuery>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [preview, setPreview] = useState<BatchStatement[] | null>(null);
  const [focusedRow, setFocusedRow] = useState<{ tab: string; row: number } | null>(null);
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
      if (!(await askGuard(caught.info))) throw new CodedError("not-authorized", t("error.notAuthorized"), { cause: caught });
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
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [homeCommand, setHomeCommand] = useState<HomeCommand | null>(null);
  const commandNonce = useRef(0);
  const rowsByTab = useRef<Record<string, SqlValue[][]>>({ [sqlTabId]: [] });
  const rowHandles = useRef<Record<string, { current: SqlValue[][] }>>({});
  const newSqlTabRef = useRef<(sql?: string, meta?: { title?: string }) => void>(() => undefined);
  /** A gridl:// link waiting for its connection to open. */
  const pendingLink = useRef<OpenLink | null>(null);
  const restoreTableStateRef = useRef<(table: TableSchema) => number>(() => 100);
  const editorRefs = useRef<Record<string, SqlEditorHandle | null>>({});
  /** The SQL tab last in front: where "Use in editor" and the history write. */
  const lastSqlTab = useRef(sqlTabId);
  const editorOf = (id: string = lastSqlTab.current) => editorRefs.current[id] ?? null;
  const relintEditors = () => {
    for (const editor of Object.values(editorRefs.current)) editor?.relint();
  };
  const sqlStageRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
    setSqlTabs([sqlTabId]);
    lastSqlTab.current = sqlTabId;
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
    setViews({ [sqlTabId]: emptyView(t("app.empty.start")) });
  };
  const schema = useMemo(() => schemaMap(tables), [tables]);
  const checker = useMemo(() => {
    if (!active) return null;
    const connectionId = active.id;
    return { key: connectionId, engine: active.engine, check: (sql: string) => checkSql(connectionId, sql) };
  }, [active]);
  const engine: DatabaseEngine = active?.engine ?? "sqlite";
  const engineInfo = engineSpec(engine);
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

  // The team file can change under us (git pull, iCloud, a teammate): read it at start,
  // when the window comes back to the front, and every 15 seconds.
  useEffect(() => {
    let lastModified: number | null | undefined;
    const refresh = () => {
      void teamState()
        .then((next) => {
          if (next.modified === lastModified && next.folder === teamRef.current.folder) return;
          lastModified = next.modified;
          setTeam(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // A shared connection the team changed (host, database, safety rules…) updates the copy
  // saved here. The keychain accounts stay this Mac's own.
  useEffect(() => {
    const updates = team.connections.flatMap((shared) => {
      const local = catalog.profiles.find((profile) => profile.id === shared.id);
      if (!local) return [];
      const merged: ConnectionConfig = { ...shared, credentialAccount: local.credentialAccount, ssh: { ...shared.ssh, credentialAccount: local.ssh.credentialAccount } };
      return JSON.stringify(merged) === JSON.stringify(local) ? [] : [merged];
    });
    if (updates.length === 0) return;
    void (async () => {
      let next: ConnectionCatalog | null = null;
      for (const config of updates) {
        next = await saveConnection({ config, password: null, rememberPassword: false, sshSecret: null, rememberSshSecret: false, trustSshHost: false }).catch(() => null);
      }
      if (next) setCatalog(next);
    })();
  }, [catalog.profiles, team.connections]);

  // A gridl:// link for this window's connection opens as a new tab, unrun.
  useEffect(() => {
    let stop = () => {};
    void listenHere<OpenLink>("gridl-open-link", (event) => {
      if (activeRef.current) newSqlTabRef.current(event.payload.sql, { title: event.payload.title || undefined });
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, []);
  useEffect(() => {
    const link = pendingLink.current;
    if (!active || !link) return;
    pendingLink.current = null;
    newSqlTabRef.current(link.sql, { title: link.title || undefined });
  }, [active]);

  // Connections saved in another window show up the next time the list opens.
  useEffect(() => {
    if (!switcherOpen) return;
    void listProfiles().then(setCatalog).catch(() => undefined);
  }, [switcherOpen]);

  /** Every SQL tab's current text, for the saved session. */
  const sqlSnapshot = (id: string) => {
    const saved = readSession(id)?.sqlTabs ?? [];
    const sqlTabsSaved = sqlTabsRef.current.map((tab) => ({
      id: tab,
      sql: editorRefs.current[tab]?.getValue() ?? sqlSeeds.current[tab] ?? saved.find((item) => item.id === tab)?.sql ?? "",
      ...sqlMetaRef.current[tab],
    }));
    return { sql: sqlTabsSaved[0]?.sql ?? "", sqlTabs: sqlTabsSaved };
  };

  const saveWorkspace = (id: string) => {
    const state = workspaceState.current;
    // Until the schema arrives the table tabs are not restored; keep the saved ones.
    const kept = schemaLoading ? readSession(id) : null;
    writeSession(id, {
      ...sqlSnapshot(id),
      activeTab: kept?.activeTab ?? state.activeTabId,
      tabs: kept?.tabs ?? workspaceTabs(state.tabs),
    });
  };
  const saveWorkspaceRef = useRef(saveWorkspace);
  saveWorkspaceRef.current = saveWorkspace;

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
      if (kind === "quick-open") {
        if (activeRef.current) setQuickOpen(true);
        return;
      }
      if (kind === "new-sql-tab") {
        if (activeRef.current) newSqlTabRef.current("");
        return;
      }
      if (kind === "open-connection") {
        if (activeRef.current) setSwitcherOpen(true);
        return;
      }
      if (kind !== "new-connection" && kind !== "new-group") return;
      // Working in a connection: open the form in a new window and keep this one as it is.
      if (activeRef.current) {
        void openHomeWindow(kind).catch((caught: unknown) => setError(errorMessage(caught)));
        return;
      }
      void (async () => {
        if (!(await confirmDiscardRef.current({ action: t("app.discard.leaveConnection") }))) return;
        setInTransaction(false);
        const current = activeRef.current;
        if (current) {
          saveWorkspaceRef.current(current.id);
          void disconnect(current.id).catch(() => undefined);
        }
        activeQuery.current = null;
        runningTab.current = null;
        commandNonce.current += 1;
        schemaEpoch.current += 1;
        setSchemaLoading(false);
        setActive(null);
        setTables([]);
        resetTableQueriesRef.current();
        rowsByTab.current = { [sqlTabId]: [] };
        setSqlTabs([sqlTabId]);
        lastSqlTab.current = sqlTabId;
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
        setViews({ [sqlTabId]: emptyView(t("app.empty.start")) });
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
        // A window opened for a gridl:// link connects, then opens the link's SQL in a tab.
        const linkText = new URLSearchParams(window.location.hash.slice(1)).get("link");
        const link = linkText ? parseLink(linkText) : null;
        if (link) {
          const target = linkTarget(link, next.profiles);
          if (target) {
            pendingLink.current = link;
            void openSavedRef.current(target);
          } else {
            setError(t("app.link.unknown", { name: link.name || link.connection }));
          }
        }
        // A window opened by ⌘N from a connection carries the command: #command=new-connection.
        const command = new URLSearchParams(window.location.hash.slice(1)).get("command");
        if (command === "new-connection" || command === "new-group") {
          commandNonce.current += 1;
          setHomeCommand({ nonce: commandNonce.current, kind: command });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      // The window has what it shows first: the connections, or an error about them.
      .finally(hideSplash);
    return () => {
      cancelled = true;
    };
  }, []);

  const browse = async (kind: BrowseKind) => {
    const filters = kind === "certificate"
      ? [{ name: t("app.browse.certificate"), extensions: ["crt", "pem", "cer"] }]
      : kind === "key"
        ? [{ name: t("app.browse.key"), extensions: ["pem", "key"] }]
        : [{ name: engineSpec(kind).name, extensions: engineSpec(kind).connection.fileExtensions }];
    const selected = await open({ multiple: false, directory: false, filters });
    return typeof selected === "string" ? selected : null;
  };

  /**
   * Opens the workspace. With `nextTables` null the catalog is read afterwards
   * (`loadSchema`): the editor is usable at once and the explorer fills in.
   */
  const enter = (config: ConnectionConfig, nextTables: TableSchema[] | null) => {
    const saved = readSession(config.id);
    const deferred = nextTables === null;
    const known = nextTables ?? [];
    const tabs = matchTabs(saved, known);
    const savedSql = saved?.sqlTabs ?? [{ id: sqlTabId, sql: saved?.sql ?? "" }];
    const sqlIds = savedSql.map((tab) => tab.id);
    const nextTab = saved && (sqlIds.includes(saved.activeTab) || tabs.some((tab) => tab.id === saved.activeTab)) ? saved.activeTab : sqlIds[0];
    schemaEpoch.current += 1;
    setSchemaLoading(deferred);
    setDialect(config.engine);
    setActive(config);
    setTables(known);
    setForeignKeys([]);
    void listForeignKeys(config.id).then(setForeignKeys).catch(() => undefined);
    setHistory(readHistory(config.id));
    setSavedQueries(readSaved(config.id));
    resetTableQueries();
    setError(null);
    setObjectQuery("");
    rowsByTab.current = Object.fromEntries(sqlIds.map((id) => [id, []]));
    rowHandles.current = {};
    sqlSeeds.current = Object.fromEntries(savedSql.map((tab) => [tab.id, tab.sql]));
    setSqlMeta(Object.fromEntries(savedSql.map((tab) => [tab.id, { title: tab.title, savedId: tab.savedId }])));
    setSqlDirty({});
    editorRefs.current = {};
    setSqlTabs(sqlIds);
    lastSqlTab.current = isSqlTab(nextTab) ? nextTab : sqlIds[0];
    setTableTabs(tabs);
    setPaging({});
    const schemaView = readSchemaView(config.id);
    setSchemaChoice(schemaView.schema);
    setAllSchemas(schemaView.all);
    setPickedRows([]);
    undoStack.current = [];
    pendingRef.current = {};
    setPending({});
    setDialog(null);
    setFormError(null);
    setActiveTabId(nextTab);
    setSelectedTable(tabs.find((tab) => tab.id === nextTab)?.table ?? null);
    setViews(Object.fromEntries(sqlIds.map((id) => [id, emptyView(t("app.empty.start"))])));
    pendingLoads.current = tabs.filter((tab) => showsRows(tab.table)).map((tab) => tab.table);
    setDbSchemas(namesFromTables(known));
    if (engineSpec(config.engine).structure.schemas) void readSchemas(config.id, config.engine).then(setDbSchemas).catch(() => undefined);
    setScreen("workspace");
    if (deferred) void loadSchema(config, sqlIds[0] ?? sqlTabId);
  };

  /**
   * Reads the catalog of a workspace opened without it, then restores the
   * table tabs of the saved session. `fallbackTab` is the tab shown meanwhile;
   * if the user is still on it, the saved active tab comes back.
   */
  const loadSchema = async (config: ConnectionConfig, fallbackTab: string) => {
    const epoch = schemaEpoch.current;
    const current = () => epoch === schemaEpoch.current && activeRef.current?.id === config.id;
    let next: TableSchema[];
    try {
      next = await introspect(config.id);
    } catch (caught) {
      if (!current()) return;
      setSchemaLoading(false);
      setViews((views) => ({
        ...views,
        [fallbackTab]: { ...(views[fallbackTab] ?? emptyView()), status: t("app.explorer.loadFailed", { error: errorMessage(caught) }) },
      }));
      return;
    }
    if (!current()) return;
    const saved = readSession(config.id);
    const tabs = matchTabs(saved, next);
    setTables(next);
    setDbSchemas((names) => [...new Set([...names, ...namesFromTables(next)])].sort((left, right) => left.localeCompare(right)));
    setTableTabs(tabs);
    const restored = tabs.find((tab) => tab.id === saved?.activeTab);
    if (restored && workspaceState.current.activeTabId === fallbackTab) {
      setActiveTabId(restored.id);
      setSelectedTable(restored.table);
    }
    pendingLoads.current = tabs.filter((tab) => showsRows(tab.table)).map((tab) => tab.table);
    setSchemaArrived((count) => count + 1);
    setSchemaLoading(false);
    relintEditors();
  };

  const openSavedRef = useRef<(profile: ConnectionConfig) => Promise<boolean>>(async () => false);
  /**
   * Connects with progress shown on the connection's card; resolves to null when
   * cancelled, or when another connection was opened meanwhile.
   */
  const connectWithStatus = (request: Parameters<typeof connect>[0]) => {
    const attempt = ++connectAttempt.current;
    const id = request.config.id;
    const previous = connectTail.current.get(id) ?? Promise.resolve();
    setConnecting({ id, stage: "connect", started: Date.now() });
    const run = (async () => {
      await previous.catch(() => undefined);
      if (attempt !== connectAttempt.current) return null;
      try {
        const response = await connect(request);
        if (attempt === connectAttempt.current) return response;
        await disconnect(response.config.id).catch(() => undefined);
        return null;
      } catch (caught) {
        if (attempt === connectAttempt.current) throw caught;
        return null;
      } finally {
        if (attempt === connectAttempt.current) setConnecting(null);
      }
    })();
    connectTail.current.set(id, run);
    void run.finally(() => {
      if (connectTail.current.get(id) === run) connectTail.current.delete(id);
    }).catch(() => undefined);
    return run;
  };
  const cancelConnecting = () => {
    connectAttempt.current += 1;
    setConnecting(null);
    setBusy(false);
  };

  const openSaved = async (profile: ConnectionConfig) => {
    setError(null);
    try {
      const response = await connectWithStatus({
        config: profile,
        password: null,
        rememberPassword: false,
        sshSecret: null,
        rememberSshSecret: false,
        trustSshHost: false,
        deferSchema: true,
      });
      if (!response) return false;
      enter(response.config, null);
      void listProfiles().then(setCatalog).catch(() => undefined);
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      // Already open in another window: the shell focused it, nothing to show here.
      if (message.startsWith("gridl-focused:")) return false;
      setError(message);
      return false;
    }
  };
  openSavedRef.current = openSaved;

  const saveDraft = async (draft: Draft, openAfter: boolean) => {
    setBusy(true);
    setError(null);
    const attempt = connectAttempt.current + 1;
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
        const response = await connectWithStatus({ ...request, deferSchema: true });
        if (!response) return false;
        enter(response.config, null);
        void listProfiles().then(setCatalog).catch(() => undefined);
      } else {
        setCatalog(await saveConnection(request));
      }
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      if (!openAfter || attempt === connectAttempt.current) setBusy(false);
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
          if (view.error && isConnectionLost(view.error.message)) next[id] = { ...view, error: null, status: t("app.reconnect.done") };
        }
        return next;
      });
      setFormError(null);
      return true;
    } catch (caught) {
      setFormError(t("app.reconnect.failed", { error: errorMessage(caught) }));
      return false;
    } finally {
      setReconnecting(false);
    }
  };
  const reconnectAction = (error: ShownError | null | undefined) =>
    error && isConnectionLost(error.message) ? { label: t("app.reconnect.action"), busy: reconnecting, run: () => void reconnectRef.current() } : null;

  const goHome = async () => {
    if (!(await confirmDiscardRef.current({ action: t("app.discard.backToConnections") }))) return;
    setInTransaction(false);
    if (active) saveWorkspace(active.id);
    const queryId = activeQuery.current;
    const closing = active?.id;
    schemaEpoch.current += 1;
    setSchemaLoading(false);
    activeQuery.current = null;
    runningTab.current = null;
    setActive(null);
    setTables([]);
    resetTabs();
    setRunning(false);
    setScreen("home");
    // The list shows at once; the running query and the session end behind it.
    // Opening the same connection again waits for that close in connectTail.
    const ending = (async () => {
      if (queryId) await cancelQuery(queryId).catch(() => undefined);
      if (closing) await disconnect(closing).catch(() => undefined);
    })();
    if (closing) {
      connectTail.current.set(closing, ending);
      void ending.finally(() => {
        if (connectTail.current.get(closing) === ending) connectTail.current.delete(closing);
      });
    }
  };

  const refreshSchema = async () => {
    if (!active) return;
    try {
      const next = await introspect(active.id);
      setTables(next);
      void listForeignKeys(active.id).then(setForeignKeys).catch(() => undefined);
      relintEditors();
      setTableTabs((current) => current.map((tab) => {
        const fresh = next.find((table) => tableTabId(table) === tab.id);
        return fresh ? { ...tab, table: fresh } : tab;
      }));
      setSelectedTable((current) => {
        if (!current) return current;
        return next.find((table) => tableTabId(table) === tableTabId(current)) ?? current;
      });
      if (engineSpec(active.engine).structure.schemas) setDbSchemas(await readSchemas(active.id, active.engine));
    } catch (caught) {
      setViews((current) => ({
        ...current,
        [lastSqlTab.current]: { ...(current[lastSqlTab.current] ?? emptyView()), status: errorMessage(caught) },
      }));
    }
  };

  refreshSchemaRef.current = () => void refreshSchema();

  /**
   * Reads one table again after its structure changed (or after it was
   * created), with what hangs from it: its indexes, its triggers and the
   * foreign keys. Everything the user can see of it is current again, and
   * the rest of the catalog, which did not change, is not read. Falls back to
   * the whole schema when the table cannot be read alone.
   */
  const refreshTable = async (table: Pick<TableSchema, "schema" | "name" | "kind">): Promise<TableSchema | null> => {
    if (!active) return null;
    const relation = { schema: table.schema ?? null, name: table.name, kind: table.kind };
    void listForeignKeys(active.id).then(setForeignKeys).catch(() => undefined);
    let fresh: TableSchema;
    let attached: TableSchema[];
    try {
      [fresh, attached] = await Promise.all([describeRelation(active.id, relation), tableObjects(active.id, relation)]);
    } catch {
      await refreshSchema();
      return null;
    }
    // Some catalogs describe a table they cannot find as one without columns.
    if (fresh.columns.length === 0) {
      await refreshSchema();
      return null;
    }
    setTables((current) => withTable(current, fresh, attached));
    const id = tableTabId(fresh);
    setTableTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, table: keepDefinition(fresh, tab.table) } : tab)));
    setSelectedTable((current) => (current && tableTabId(current) === id ? keepDefinition(fresh, current) : current));
    relintEditors();
    return fresh;
  };

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

  const runQuery = useCallback(async (tabId: string, sql?: string | string[], maxRows = editorRowSteps[0], values?: Record<string, SqlValue>) => {
    if (!active || running) return;
    // A selection can hold several statements; it runs as a script, like "All".
    const requested = Array.isArray(sql) ? sql : splitStatements(sql ?? editorRefs.current[tabId]?.getActiveSql() ?? "");
    const statements = requested.map((item) => item.trim()).filter(Boolean);
    // :name parameters are asked for first, then the same run starts again with their values.
    const names = [...new Set(statements.flatMap((statement) => findParams(statement, active.engine)))];
    if (names.length > 0 && !values) {
      setParamPrompt({ tabId, statements, maxRows, names });
      return;
    }
    if (statements.length === 0) {
      setViews((current) => ({
        ...current,
        [tabId]: { ...(current[tabId] ?? emptyView()), status: t("app.status.noSql") },
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
    // A script keeps every statement's result; a single statement needs none.
    const results: ScriptResult[] = [];
    try {
      let result: Awaited<ReturnType<typeof executeQuery>> | null = null;
      for (let index = 0; index < total; index += 1) {
        const statement = statements[index] ?? "";
        const thisQuery = index === 0 ? queryId : crypto.randomUUID();
        queryId = thisQuery;
        activeQuery.current = thisQuery;
        rows.length = 0;
        const prefix = total > 1 ? `${index + 1}/${total} · ` : "";
        setViews((current) => ({ ...current, [tabId]: { columns: [], rowCount: 0, status: `${prefix}${t("app.status.running")}`, error: null, pending: true, ran: true } }));
        const bound = values ? bindParams(statement, active.engine, values) : { sql: statement, params: [] };
        const execute = (authorized: boolean) => executeQuery(
          { connectionId, queryId: thisQuery, sql: bound.sql, params: bound.params, chunkRows: 500, authorized, maxRows },
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
            if (!(await askGuard(caught.info, total - index > 1))) throw new CodedError("not-authorized", t("error.notAuthorized"), { cause: caught });
            scriptAuthorized = true;
            result = await execute(true);
          }
        } catch (caught) {
          setHistory(pushHistory(connectionId, { sql: statement, at: Date.now(), durationMs: null, ok: false }));
          failedSql = statement;
          if (total > 1) results.push({ sql: statement, columns: [], rows: [], rowsAffected: 0, durationMs: 0, error: describeError(caught, statement, active.engine) });
          if (total === 1) throw caught;
          throw new Error(t("app.error.statement", { index: index + 1, total, error: errorMessage(caught) }), { cause: caught });
        }
        setHistory(pushHistory(connectionId, { sql: statement, at: Date.now(), durationMs: result.durationMs, ok: true }));
        if (total > 1) results.push({ sql: statement, columns: result.columns, rows: rows.slice(), rowsAffected: result.rowsAffected, durationMs: result.durationMs });
        affected += result.rowsAffected;
        const bare = withoutComments(statement);
        if (schemaChange.test(bare)) changedSchema = true;
        if (/^\s*(begin|start\s+transaction)\b/i.test(bare)) setInTransaction(true);
        else if (/^\s*(commit|end|abort|rollback)\b(?!\s+to\b)/i.test(bare)) setInTransaction(false);
        if (result.cancelled) break;
      }
      if (!result) return;
      const finalResult = result;
      const notes = [
        finalResult.cancelled ? t("app.status.cancelled") : null,
        finalResult.truncated ? t("app.status.truncated", { count: formatNumber(maxRows) }) : null,
      ].filter((note) => note !== null);
      const returnsRows = finalResult.columns.length > 0 || finalResult.rowCount > 0;
      const command = commandTag(statements[0] ?? "");
      const headline = total > 1
        ? `${plural("app.status.statements", total)} · ${returnsRows ? plural("app.status.rowsInLast", finalResult.rowCount) : affected > 0 ? plural("app.status.rowsAffected", affected) : t("app.status.completed")}`
        : returnsRows ? plural("common.rows", finalResult.rowCount)
          : command && finalResult.rowsAffected === 0 ? t("app.status.commandDone", { command })
            : plural("app.status.rowsAffected", finalResult.rowsAffected);
      const duration = total > 1 ? Math.round(performance.now() - started) : finalResult.durationMs;
      const status = `${headline} · ${duration} ms${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
      const lastStatement = statements[total - 1] ?? "";
      const nextLimit = editorRowSteps.find((step) => step > maxRows);
      const more = finalResult.truncated && nextLimit && rerunnable.test(withoutComments(lastStatement)) && !modifies.test(withoutComments(lastStatement))
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
          results: results.length > 1 ? results : undefined,
          shown: results.length > 1 ? results.length - 1 : undefined,
        },
      }));
    } catch (caught) {
      if (activeQuery.current === queryId) {
        const shown = describeError(caught, failedSql, active.engine);
        const at = formatTime(new Date());
        setViews((current) => ({
          ...current,
          [tabId]: {
            columns: [],
            rowCount: 0,
            status: t("app.status.errorAt", { time: at }),
            error: shown,
            pending: false,
            ran: true,
            // The statements that ran before the failure stay one click away.
            results: results.length > 1 ? results : undefined,
            shown: results.length > 1 ? results.length - 1 : undefined,
          },
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
      for (const editor of Object.values(editorRefs.current)) editor?.relint();
    }
  }, [active, askGuard, running]);

  const formatEditor = (tabId: string) => {
    try {
      editorOf(tabId)?.format();
    } catch (caught) {
      setStatus(tabId, t("app.status.formatFailed", { error: errorMessage(caught) }));
    }
  };

  /** Asks the database how it would run the statement under the cursor, without running it. */
  const explainQuery = async (tabId: string) => {
    if (!active || running) return;
    const statement = editorOf(tabId)?.getActiveSql().trim() ?? "";
    if (!statement) {
      setStatus(tabId, t("app.status.noSql"));
      return;
    }
    const queryId = crypto.randomUUID();
    activeQuery.current = queryId;
    runningTab.current = tabId;
    setRunning(true);
    setViews((current) => ({ ...current, [tabId]: { columns: [], rowCount: 0, status: t("app.plan.running"), error: null, pending: true, ran: true } }));
    try {
      const rows: SqlValue[][] = [];
      const result = await executeQuery(
        { connectionId: active.id, queryId, sql: explainSql(active.engine, statement), params: [], chunkRows: 500 },
        (chunk) => {
          if (chunk.queryId === queryId) rows.push(...chunk.rows);
        },
      );
      const plan = parsePlan(active.engine, rows);
      setViews((current) => ({
        ...current,
        [tabId]: { columns: [], rowCount: 0, status: `${t("app.plan.title")} · ${result.durationMs} ms`, error: null, pending: false, ran: true, plan },
      }));
    } catch (caught) {
      setViews((current) => ({
        ...current,
        [tabId]: { columns: [], rowCount: 0, status: t("app.status.error"), error: describeError(caught, statement, active.engine), pending: false, ran: true },
      }));
    } finally {
      if (activeQuery.current === queryId) {
        setRunning(false);
        runningTab.current = null;
      }
    }
  };

  const runScript = (tabId: string) => {
    const statements = splitStatements(editorOf(tabId)?.getValue() ?? "");
    void runQuery(tabId, statements);
  };

  const newSqlTab = (sql = "", meta: { title?: string; savedId?: string } = {}) => {
    const id = nextSqlTabId(sqlTabsRef.current);
    sqlSeeds.current[id] = sql;
    setSqlMeta((current) => ({ ...current, [id]: meta }));
    rowsByTab.current[id] = [];
    setViews((current) => ({ ...current, [id]: emptyView(t("app.empty.start")) }));
    setSqlTabs((current) => [...current, id]);
    lastSqlTab.current = id;
    setActiveTabId(id);
  };

  newSqlTabRef.current = (sql, meta) => newSqlTab(sql, meta);

  /** What a script's statement without rows did, when that statement is on screen. */
  const pickedWrite = (view: TabView) => {
    const picked = view.results?.[view.shown ?? -1];
    if (!picked || picked.error || picked.columns.length > 0) return null;
    return `${scriptWriteSummary(picked)} · ${picked.durationMs} ms`;
  };

  /** Puts one statement's result of the last script back on screen. */
  const showResult = (tabId: string, index: number) => {
    const view = views[tabId];
    const result = view?.results?.[index];
    if (!view || !result) return;
    // The grid reads this array through a handle, so it is refilled in place.
    const rows = rowsByTab.current[tabId] ?? [];
    rows.length = 0;
    for (const row of result.rows) rows.push(row);
    rowsByTab.current[tabId] = rows;
    setFocusedRow((current) => (current?.tab === tabId ? null : current));
    setViews((current) => ({
      ...current,
      [tabId]: { ...view, columns: result.columns, rowCount: result.rows.length, error: result.error ?? null, shown: index },
    }));
  };

  /** Opens a saved query in its own tab, or goes back to the tab that already holds it. */
  const openSavedQuery = (query: SavedQuery) => {
    const holder = sqlTabsRef.current.find((tab) => sqlMetaRef.current[tab]?.savedId === query.id);
    if (holder) focusTab(holder);
    else newSqlTab(query.sql, { title: query.name, savedId: query.id });
  };

  const closeSqlTab = (id: string) => {
    const open = sqlTabsRef.current;
    if (open.length <= 1) return;
    if (runningTab.current === id) return;
    const text = editorOf(id)?.getValue() ?? "";
    if (text.trim() && !window.confirm(t("app.sqlTabs.confirmClose", { name: sqlTabLabel(id) }))) return;
    const index = open.indexOf(id);
    const remaining = open.filter((tab) => tab !== id);
    const neighbour = remaining[Math.min(index, remaining.length - 1)] ?? remaining[0];
    delete editorRefs.current[id];
    delete sqlSeeds.current[id];
    setSqlMeta((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete rowsByTab.current[id];
    delete rowHandles.current[id];
    setViews((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setFocusedRow((current) => (current?.tab === id ? null : current));
    setSqlTabs(remaining);
    if (lastSqlTab.current === id) lastSqlTab.current = neighbour;
    setActiveTabId((current) => (current === id ? neighbour : current));
  };

  const queryQueue = useRef(Promise.resolve());
  const collectQuery = useCallback(async (sql: string, options: { skip?: () => boolean; background?: (queryId: string) => void } = {}) => {
    if (!active) throw new Error(t("app.error.noConnection"));
    const connectionId = active.id;
    const chunkRows = 100;
    const run = async () => {
      // A query that is no longer wanted by the time its turn comes is dropped.
      if (options.skip?.()) return null;
      let result: Awaited<ReturnType<typeof executeQuery>> | null = null;
      let rows: SqlValue[][] = [];
      let columns: ColumnDefinition[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const queryId = crypto.randomUUID();
        // Background reads (row counts) report their id instead of taking over the Cancel button.
        if (options.background) options.background(queryId);
        else activeQuery.current = queryId;
        rows = [];
        columns = [];
        result = await executeQuery(
          { connectionId, queryId, sql, params: [], chunkRows, browse: true },
          (chunk) => {
            if (chunk.queryId !== queryId) return;
            if (chunk.index === 0 && chunk.columns.length > 0) columns = chunk.columns;
            const incoming = Array.isArray(chunk.rows) ? chunk.rows : [];
            for (const row of incoming) rows.push(row.slice());
          },
        );
        if (Number(result.rowCount) <= rows.length) break;
      }
      if (!result) throw new Error(t("app.error.noResult"));
      if (columns.length === 0) columns = result.columns;
      if (Number(result.rowCount) > rows.length) {
        throw new Error(t("app.error.partialRows", { received: formatNumber(rows.length), total: formatNumber(Number(result.rowCount)) }));
      }
      return { result, rows, columns };
    };
    const queued = queryQueue.current.then(run, run);
    queryQueue.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [active]);

  /** Counts the rows of the shown query after its page is on screen, without holding the grid. */
  const countRows = useCallback(async (table: TableSchema, shownPage: TablePage, where: string, durationMs: number, token: number, exact: boolean) => {
    if (!active) return;
    const id = tableTabId(table);
    const current = () => loadToken.current[id] === token;
    const update = (total: number | null, approximate: boolean) => {
      if (!current()) return;
      const next: TablePage = { ...shownPage, total, approximate };
      setPaging((paged) => ({ ...paged, [id]: next }));
      setViews((views) => (views[id] ? { ...views, [id]: { ...views[id], status: pageStatus(next, Boolean(where), durationMs) } } : views));
    };
    try {
      // Large tables without a filter show the catalog's estimate: counting them reads every row.
      const estimateSql = where || exact ? null : rowEstimateSql(table, active.engine);
      if (estimateSql) {
        const estimated = await collectQuery(estimateSql, { skip: () => !current(), background: (queryId) => (countQuery.current[id] = queryId) });
        const estimate = estimated ? countValue(estimated.rows[0]?.[0]) : 0;
        if (estimate >= largeTableRows) {
          update(estimate, true);
          return;
        }
      }
      if (!current()) return;
      const counted = await collectQuery(`select count(*) as total from ${qualifiedName(table)}${where}`, { skip: () => !current(), background: (queryId) => (countQuery.current[id] = queryId) });
      if (!counted || counted.result.cancelled) return;
      update(countValue(counted.rows[0]?.[0]), false);
    } catch {
      // The rows are already shown; a failed count only leaves the total unknown.
      update(null, false);
    } finally {
      if (current()) delete countQuery.current[id];
    }
  }, [active, collectQuery]);

  const loadTable = useCallback(async (table: TableSchema, page: number, pageSize: number, keepPending = false, discard = false, retried = false, keepTotal = false): Promise<void> => {
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
    const token = (loadToken.current[id] ?? 0) + 1;
    loadToken.current[id] = token;
    // A count still running for the previous load would hold this one back.
    const staleCount = countQuery.current[id];
    if (staleCount) {
      delete countQuery.current[id];
      void cancelQuery(staleCount).catch(() => undefined);
    }
    setViews((current) => ({
      ...current,
      [id]: { ...(current[id] ?? emptyView()), status: t("app.status.loading"), error: null },
    }));
    setRunning(true);
    try {
      const query = tableQueryRef.current[id];
      const where = whereClause(query?.filters ?? [], active.engine);
      const order = orderClause(table, query?.sort ?? null);
      // The page comes first so rows show at once; the total is counted after.
      const nextPage = Math.max(0, page);
      const offset = nextPage * size;
      const loaded = await collectQuery(
        `select * from ${qualifiedName(table)}${where}${pageClause(active.engine, order, size, offset)}`,
      );
      if (!loaded || (loaded.result.cancelled && loaded.rows.length === 0)) return;
      if (loaded.rows.length === 0 && nextPage > 0) {
        // Past the end, e.g. after deleting the last page's rows: go to the last page there is.
        const counted = await collectQuery(`select count(*) as total from ${qualifiedName(table)}${where}`);
        const last = Math.max(0, Math.ceil(countValue(counted?.rows[0]?.[0]) / size) - 1);
        if (last < nextPage) {
          await loadTable(table, last, size, true, discard, retried);
          return;
        }
      }
      const bucket = rowsByTab.current[id] ?? [];
      bucket.length = 0;
      for (const row of loaded.rows) bucket.push(row);
      rowsByTab.current[id] = bucket;
      const columns = mergeColumns(loaded.columns, table);
      // Moving between pages of the same query keeps the total already counted.
      const known = keepTotal ? pagingRef.current[id] : undefined;
      const reuse = known !== undefined && known.total !== null;
      const shownPage: TablePage = { page: nextPage, pageSize: size, shown: loaded.rows.length, total: reuse ? known.total : null, approximate: reuse ? known.approximate : false };
      setViews((current) => ({
        ...current,
        [id]: { columns, rowCount: loaded.rows.length, status: pageStatus(shownPage, Boolean(where), loaded.result.durationMs) },
      }));
      setPaging((current) => ({ ...current, [id]: shownPage }));
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
      if (!reuse) void countRows(table, shownPage, where, loaded.result.durationMs, token, false);
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
        const shown = describeError(caught, null, active.engine);
        setViews((current) => ({
          ...current,
          [id]: { ...(current[id] ?? emptyView()), status: t("app.status.error"), error: shown },
        }));
      }
    } finally {
      if (runningTab.current === id) {
        setRunning(false);
        runningTab.current = null;
      }
    }
  }, [active, collectQuery, countRows, putStashes]);

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
    // Drop the view with its rows: a stale row count over an empty buffer draws a grid of NULLs.
    setViews((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
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
    for (const table of loads) void loadTable(table, 0, restoreTableStateRef.current(table));
    return undefined;
  }, [active, loadTable, schemaArrived]);

  useEffect(() => {
    // Until the schema arrives the table tabs are not restored yet; saving now would drop them.
    if (!active || schemaLoading) return undefined;
    writeSession(active.id, { ...sqlSnapshot(active.id), activeTab: activeTabId, tabs: workspaceTabs(tableTabs) });
    return undefined;
    // sqlTabs is read through its ref; listing it re-saves when tabs open or close.
  }, [active, activeTabId, tableTabs, sqlTabs, schemaLoading]);

  // Each open table remembers its filters, sort and page size for the next visit.
  useEffect(() => {
    if (!active) return;
    const states = Object.fromEntries(
      tableTabs
        .filter((tab) => paging[tab.id])
        .map((tab) => [tab.id, { ...(tableQueries[tab.id] ?? { filters: [], sort: null }), pageSize: paging[tab.id]?.pageSize }]),
    );
    writeTableStates(active.id, states);
  }, [active, tableTabs, tableQueries, paging]);

  const pinTable = (id: string) => {
    setTableTabs((current) => {
      const tab = current.find((item) => item.id === id);
      if (!tab || tab.pinned) return current;
      return current.map((item) => (item.id === id ? { ...item, pinned: true } : item));
    });
  };

  /** Puts back a table's last filters and sort; returns its last page size. */
  const restoreTableState = (table: TableSchema): number => {
    const id = tableTabId(table);
    const saved = active ? readTableState(active.id, id, table) : null;
    if (saved && !tableQueryRef.current[id]) {
      tableQueryRef.current = { ...tableQueryRef.current, [id]: { filters: saved.filters, sort: saved.sort } };
      setTableQueries(tableQueryRef.current);
    }
    return paging[id]?.pageSize ?? saved?.pageSize ?? 100;
  };

  restoreTableStateRef.current = restoreTableState;

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
        [id]: emptyView(table.definition ? "" : t("app.definition.none")),
      }));
      return;
    }
    void loadTable(table, 0, restoreTableState(table));
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
    if (!(await confirmDiscardRef.current({ tab: id, action: t("app.discard.closeTab") }))) return;
    setTableTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTabId((current) => (current === id ? lastSqlTab.current : current));
    forgetTab(id);
  };

  const focusTab = (id: string) => {
    if (isSqlTab(id)) lastSqlTab.current = id;
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
  const schemaCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      if (table.schema && table.kind === "table") counts[table.schema] = (counts[table.schema] ?? 0) + 1;
    }
    return counts;
  }, [tables]);
  const pickSchema = (name: string, all: boolean) => {
    if (name) setSchemaChoice(name);
    setAllSchemas(all);
    if (active) writeSchemaView(active.id, { schema: name || activeSchema, all });
  };
  /** Searching looks through every schema, so a match in another one is never hidden. */
  const schemaTree = engineInfo.structure.schemas && (allSchemas || Boolean(needle));
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
    const owned = searched.filter((table) => (engineInfo.structure.schemas ? table.schema === schema : true));
    const tableKey = `tables:${schema ?? "main"}`;
    const tableRows = owned.filter((table) => table.kind === "table");
    return (
      <>
        {!needle || tableRows.length > 0 ? (
          <TreeBranch
            label={t("app.explorer.tables")}
            depth={groupDepth}
            icon={<Folder size={14} />}
            open={branchOpen(tableKey, true)}
            onToggle={() => toggleBranch(tableKey, true)}
            actions={
              <button
                type="button"
                className="tiny-icon"
                aria-label={t("app.explorer.newTable")}
                disabled={structureLocked || running || (engineInfo.structure.schemas && !schema)}
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
  const tableView = activeTable ? (views[activeTable.id] ?? emptyView()) : null;
  const writable = activeTable ? canEditRows(activeTable.table, editLocked) : false;
  const structureTable = activeTable?.table.kind === "table"
    ? activeTable.table
    : detailTable?.kind === "table"
      ? detailTable
      : null;

  /** Reloads a table's rows; after a change to its structure, its columns first. */
  const reloadOpenTable = async (table: TableSchema, keepPending = false, structureChanged = true) => {
    const fresh = structureChanged ? await refreshTable(table) : null;
    const page = paging[tableTabId(table)];
    await loadTable(fresh ?? table, page?.page ?? 0, page?.pageSize ?? 100, keepPending);
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
      const schema = engineInfo.structure.schemas ? activeSchema || null : null;
      const sql = createTableSql(schema, name, columns, engine);
      const ok = await runWrite(sql);
      if (!ok) return;
      setDialog(null);
      // Only the new table needs reading; it joins the explorer as it is.
      await refreshTable({ schema, name: name.trim(), kind: "table" });
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
        if (errorCode(caught) === "no-changes") continue;
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
    await reloadOpenTable(activeTable.table, false, false);
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
      await reloadOpenTable(job.table, false, false);
      setStatus(job.tab, plural("app.status.imported", done.rows, { ms: done.durationMs }));
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
    const base = (engineSpec(active.engine).connection.fileBased ? active.database.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") : active.database) || t("app.backup.defaultName");
    const extension = engineSpec(active.engine).tools.backup === "vacuum-into" ? "sqlite" : "sql";
    const path = await save({ defaultPath: `${base}-${stamp}.${extension}`, filters: [{ name: t("app.backup.filter"), extensions: [extension] }] });
    if (!path) return;
    setBackupNote(t("app.backup.creating"));
    try {
      const done = await backupDatabase({ connectionId: active.id, path, password: null });
      const size = done.bytes > 1_048_576 ? `${(done.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(done.bytes / 1024))} KB`;
      setBackupNote(t("app.backup.done", { path: done.path, size, seconds: (done.durationMs / 1000).toFixed(1) }));
    } catch (caught) {
      setBackupNote(t("app.backup.failed", { error: errorMessage(caught) }));
    }
  };

  const runRestore = async () => {
    if (!active) return;
    setBackupMenu(false);
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "SQL", extensions: ["sql", "dump"] }] });
    if (typeof picked !== "string") return;
    setBackupNote(t("app.restore.running"));
    try {
      const done = await guarded((authorized) => restoreDatabase({ connectionId: active.id, path: picked, password: null, authorized }));
      setBackupNote(t("app.restore.done", { seconds: (done.durationMs / 1000).toFixed(1) }));
      await refreshSchema();
    } catch (caught) {
      setBackupNote(t("app.restore.failed", { error: errorMessage(caught) }));
    }
  };

  const exportResult = async (tabId: string, format: ExportFormat) => {
    if (!active) return;
    const table = isSqlTab(tabId) ? null : (tableTabs.find((tab) => tab.id === tabId)?.table ?? null);
    try {
      const path = await save({
        defaultPath: `${table?.name ?? t("app.export.defaultName")}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      if (table) {
        // The whole table goes from the database to the file in Rust; the UI never holds the rows.
        setStatus(tabId, t("app.export.running"));
        const query = tableQueryRef.current[tabId];
        const queryId = crypto.randomUUID();
        const stop = await listenHere<{ queryId: string; rows: number }>("gridl-export-progress", (event) => {
          if (event.payload.queryId === queryId) setStatus(tabId, plural("app.export.progress", event.payload.rows));
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
          setStatus(tabId, plural("app.export.doneSized", done.rows, { size, path }));
        } finally {
          stop();
        }
        return;
      }
      const columns = views[tabId]?.columns ?? [];
      const rows = rowsByTab.current[tabId] ?? [];
      await writeExport(path, exportRows(format, columns, rows, engine, quoteIdent(t("app.export.defaultName"))));
      setStatus(tabId, plural("app.export.done", rows.length, { path }));
    } catch (caught) {
      setStatus(tabId, t("app.export.failed", { error: errorMessage(caught) }));
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
    void confirmDiscardRef.current({ tab: id, action: t("app.discard.reload"), currentPageOnly: true }).then((ok) => {
      if (!ok) return;
      const page = paging[id];
      void loadTable(table, page?.page ?? 0, page?.pageSize ?? 100, false, true);
    });
  };
  closeTabRef.current = () => {
    if (screen !== "workspace") return;
    if (document.querySelector(".modal-backdrop")) return;
    if (isSqlTab(activeTabId)) closeSqlTab(activeTabId);
    else void closeTable(activeTabId);
  };
  workspaceState.current = { id: active?.id ?? null, tabs: tableTabs, activeTabId };

  const onSqlChange = (tab: string, sql: string) => {
    const savedId = sqlMetaRef.current[tab]?.savedId;
    if (savedId) {
      const dirty = savedQueriesRef.current.find((query) => query.id === savedId)?.sql.trim() !== sql.trim();
      setSqlDirty((current) => (Boolean(current[tab]) === dirty ? current : { ...current, [tab]: dirty }));
    }
    const id = activeRef.current?.id;
    if (!id) return;
    const state = workspaceState.current;
    writeSession(id, { ...sqlSnapshot(id), activeTab: state.activeTabId, tabs: workspaceTabs(state.tabs) });
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
      const summary = pendingSummary(edit);
      if (summary) items.push(`${nameOf(id)}: ${summary}`);
    }
    for (const [id, list] of Object.entries(currentPageOnly ? {} : stashes)) {
      if (tab && id !== tab) continue;
      for (const stash of list) {
        const summary = pendingSummary(stash.edit);
        if (summary) items.push(`${nameOf(id)} (${stash.label}): ${summary}`);
      }
    }
    for (const [id, draft] of Object.entries(currentPageOnly ? {} : structureDrafts)) {
      if (tab && id !== tab) continue;
      const table = tableTabs.find((item) => item.id === id)?.table;
      if (table && structureKey(table) === draft.signature) items.push(t("app.unsaved.structure", { table: table.name }));
    }
    if (!tab && inTransaction) items.push(t("app.unsaved.transaction"));
    return items;
  };
  const unsaved = unsavedItems().length > 0;
  confirmDiscardRef.current = (scope) => {
    const items = unsavedItems(scope?.tab, scope?.currentPageOnly);
    if (items.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      discardResolve.current?.(false);
      discardResolve.current = resolve;
      setDiscardAsk({ items, action: scope?.action ?? t("app.discard.continue") });
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
      void confirmDiscardRef.current({ action: quitting ? t("app.discard.quit") : t("app.discard.closeWindow") }).then((ok) => {
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

  useEffect(() => {
    let stop = () => {};
    void listenHere<string>("gridl-connect-progress", (event) => {
      if (event.payload === "schema") setConnecting((current) => (current ? { ...current, stage: "schema" } : current));
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, []);

  const updates = <UpdateCenter beforeRestart={() => confirmDiscardRef.current({ action: t("app.discard.update") })} />;

  if (screen === "home") {
    return (
      <>
      <ConnectionHome
        catalog={catalog}
        busy={busy}
        error={error}
        connecting={connecting}
        onCancelConnect={cancelConnecting}
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
        team={team}
        onLinkTeam={() => {
          void open({ directory: true, multiple: false })
            .then((folder) => (typeof folder === "string" ? teamLink(folder).then(setTeam) : undefined))
            .catch((caught: unknown) => setError(errorMessage(caught)));
        }}
        onUnlinkTeam={() => {
          if (window.confirm(t("home.team.confirmUnlink", { folder: team.folder ?? "" }))) void teamLink(null).then(setTeam).catch((caught: unknown) => setError(errorMessage(caught)));
        }}
        onShare={(profile) => {
          void teamShare(profile).then(setTeam).catch((caught: unknown) => setError(errorMessage(caught)));
        }}
        onUnshare={(profile) => {
          if (window.confirm(t("home.team.confirmUnshare", { name: profile.name }))) void teamUnshare(profile.id).then(setTeam).catch((caught: unknown) => setError(errorMessage(caught)));
        }}
      />
      {updates}
      </>
    );
  }

  const hostLine = !active
    ? ""
    : engineSpec(active.engine).connection.fileBased
      ? active.database
      : `${active.host ?? "localhost"}:${active.port ?? engineSpec(active.engine).connection.defaultPort ?? ""}`;
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
      const rowsLabel = plural("common.rows", range.rows);
      const items: MenuItem[] = [
        { label: plural("app.menu.copyCells", range.cells), hint: "⌘C", run: () => range.copy(false) },
        { label: t("app.menu.copyWithHeaders"), run: () => range.copy(true) },
      ];
      items.push({ label: t("app.menu.copyRowsAsJson", { rows: rowsLabel }), run: range.copyJson });
      if (tab) items.push({ label: t("app.menu.copyRowsAsInsert", { rows: rowsLabel }), run: () => range.copyInserts(qualifiedName(tab.table), engine) });
      if (writableRange) {
        items.push("separator");
        items.push({ label: t("app.menu.paste"), hint: "⌘V", run: range.paste });
        items.push({ label: plural("app.menu.setNullCells", range.cells), run: range.clear });
        items.push({ label: t("app.menu.deleteRows", { rows: rowsLabel }), hint: "⌫", danger: true, run: range.removeRows });
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
        items.push({ label: t("app.menu.openIn", { table: key.refTable }), disabled: isNull, run: () => openReferenced(key, columns, values) });
        items.push("separator");
      }
    }
    items.push({ label: t("app.menu.copyValue"), run: () => copyText(isNull ? "" : formatSqlValue(value)) });
    items.push({ label: t("app.menu.copyRow"), run: () => copyText(toTsv(columns, [values], false)) });
    items.push({ label: t("app.menu.copyRowWithHeaders"), run: () => copyText(toTsv(columns, [values], true)) });
    items.push({ label: t("app.menu.copyRowAsJson"), run: () => copyText(JSON.stringify(JSON.parse(toJson(columns, [values]))[0], null, 2)) });
    if (tab) {
      const target = qualifiedName(tab.table);
      items.push({
        label: t("app.menu.copyAsInsert"),
        run: () => copyText(`INSERT INTO ${target} (${columns.map((item) => quoteIdent(item.name)).join(", ")}) VALUES (${columns.map((_, index) => sqlLiteral(values[index], engine)).join(", ")});`),
      });
    }
    if (tab && draftIndex < 0) {
      items.push("separator");
      items.push({
        label: isNull ? t("app.menu.filterNull", { column: column.name }) : t("app.menu.filterEquals", { column: column.name, value: formatSqlValue(value).slice(0, 40) }),
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
        items.push({ label: t("app.menu.setNull"), disabled: isNull || !column.nullable, run: () => editCell(menu.row, menu.column, { t: "null" }) });
        items.push({ label: t("app.menu.deleteRow"), danger: true, run: () => markRows([menu.row]) });
      }
    }
    return items;
  };


  return (
    <div className="workspace-shell">
      <header className={`workspace-topbar env-${safety.environment}`} data-tauri-drag-region>
        <button type="button" className="back-button" onClick={() => void goHome()}>
          <ArrowLeft size={17} /> {t("app.topbar.connections")}
        </button>
        <div className="workspace-separator" />
        {active ? (
          <ConnectionSwitcher
            current={active}
            profiles={catalog.profiles}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            onPick={(profile) => void openConnectionWindow(profile.id).catch((caught: unknown) => setError(errorMessage(caught)))}
            onNew={() => void openHomeWindow("new-connection").catch((caught: unknown) => setError(errorMessage(caught)))}
          />
        ) : null}
        <span className="workspace-host" data-tauri-drag-region>{hostLine}</span>
        {safety.environment !== "local" ? (
          <span className={`env-pill env-${safety.environment}`} title={t("app.topbar.environment")}>{environmentLabel(safety.environment)}</span>
        ) : null}
        {active?.readOnly ? <span className="readonly-badge">{t("app.topbar.readOnly")}</span> : null}
        <div className="topbar-actions">
          {backupNote ? (
            <span className="backup-note" title={backupNote} onClick={() => setBackupNote(null)}>{backupNote}</span>
          ) : null}
          <div className="popover-anchor">
            <button type="button" className="toolbar-button" onClick={() => setBackupMenu((current) => !current)}>
              <ArchiveRestore size={14} /> {t("app.backup.button")}
            </button>
            {backupMenu ? (
              <div className="popover-menu" onMouseLeave={() => setBackupMenu(false)}>
                <button type="button" onClick={() => void runBackup()}>{t("app.backup.create")}</button>
                <button type="button" disabled={!active || !engineSpec(active.engine).tools.restore || structureLocked} onClick={() => void runRestore()}>{t("app.backup.restore")}</button>
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
            <span>{t("app.explorer.title")}</span>
            <span className="explorer-heading-actions">
              <button type="button" className="tiny-icon" aria-label={t("app.diagram.title")} title={t("app.diagram.openTitle")} onClick={() => setDiagramOpen(true)}>
                <Network size={15} />
              </button>
              <button type="button" className="tiny-icon" aria-label={t("app.explorer.refresh")} onClick={() => void refreshSchema()}>
                <Database size={15} />
              </button>
            </span>
          </div>
          <div className="explorer-search">
            <Search size={14} />
            <input value={objectQuery} placeholder={t("app.explorer.search")} onChange={(event) => setObjectQuery(event.target.value)} />
          </div>
          {engineInfo.structure.schemas && !(schemaLoading && schemaNames.length === 0) ? (
            <div className="schema-bar">
              <SchemaPicker
                schemas={schemaNames}
                counts={schemaCounts}
                current={activeSchema}
                all={allSchemas}
                onPick={(name) => pickSchema(name, false)}
                onShowAll={() => pickSchema("", true)}
              />
              {!allSchemas && activeSchema ? (
                <>
                  {engineInfo.structure.renameSchemas ? (
                    <button type="button" className="tiny-icon" aria-label={t("app.explorer.rename", { name: activeSchema })} title={t("app.explorer.rename", { name: activeSchema })} disabled={structureLocked || running} onClick={() => openDialog({ kind: "rename-schema", name: activeSchema })}>
                      <Pencil size={13} />
                    </button>
                  ) : null}
                  <button type="button" className="tiny-icon" aria-label={t("app.explorer.delete", { name: activeSchema })} title={t("app.explorer.delete", { name: activeSchema })} disabled={structureLocked || running} onClick={() => openDialog({ kind: "drop-schema", name: activeSchema })}>
                    <Trash2 size={13} />
                  </button>
                </>
              ) : null}
              <button type="button" className="tiny-icon" aria-label={t("app.explorer.createSchema")} title={t("app.explorer.createSchema")} disabled={structureLocked || running} onClick={() => openDialog({ kind: "create-schema" })}>
                <Plus size={14} />
              </button>
            </div>
          ) : null}
          <div className="tree-section">
            {schemaLoading ? (
              <div className="tree-item depth-0 schema-loading" role="status">
                <LogoLoader size={18} /> {t("app.explorer.loading")}
              </div>
            ) : null}
            {engineInfo.structure.schemas && !schemaTree ? (
              activeSchema ? renderGroups(activeSchema, "depth-0", "depth-1") : schemaLoading ? null : <div className="tree-item depth-0">{t("app.explorer.noSchemas")}</div>
            ) : (
            <TreeBranch
              label={active?.database || t("app.explorer.database")}
              depth="depth-0 tree-root"
              icon={<Database size={15} />}
              open={branchOpen("db", true)}
              onToggle={() => toggleBranch("db", true)}
            >
              {engineInfo.structure.schemas ? (
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
                          {engineInfo.structure.renameSchemas ? (
                            <button type="button" className="tiny-icon" aria-label={t("app.explorer.rename", { name })} disabled={structureLocked || running} onClick={() => openDialog({ kind: "rename-schema", name })}>
                              <Pencil size={13} />
                            </button>
                          ) : null}
                          <button type="button" className="tiny-icon" aria-label={t("app.explorer.delete", { name })} disabled={structureLocked || running} onClick={() => openDialog({ kind: "drop-schema", name })}>
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
              {engineInfo.structure.schemas && schemaNames.length === 0 && !schemaLoading ? <div className="tree-item depth-1">{t("app.explorer.noSchemas")}</div> : null}
            </TreeBranch>
            )}
            {savedQueries.length > 0 ? (
              <TreeBranch
                label={`${t("app.saved.title")} · ${savedQueries.length}`}
                depth="depth-0 saved-root"
                icon={<Bookmark size={14} />}
                open={branchOpen("saved", true)}
                onToggle={() => toggleBranch("saved", true)}
              >
                {savedQueries
                  .filter((query) => !needle || query.name.toLowerCase().includes(needle))
                  .map((query) => (
                    <div key={query.id} className="tree-item depth-1 saved-item">
                      <button type="button" className="saved-open" title={query.sql} onClick={() => openSavedQuery(query)}>
                        <FileCode size={13} /> <span>{query.name}</span>
                      </button>
                      <button
                        type="button"
                        className="tiny-icon"
                        aria-label={t("app.saved.remove", { name: query.name })}
                        title={t("app.saved.remove", { name: query.name })}
                        onClick={() => {
                          if (!active || !window.confirm(t("app.saved.confirmRemove", { name: query.name }))) return;
                          if (sharedConnection) void teamSaveQueries(active.id, savedQueries.filter((item) => item.id !== query.id)).then(setTeam).catch(() => undefined);
                          else setSavedQueries(removeSaved(active.id, query.id));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
              </TreeBranch>
            ) : null}
          </div>
        </aside>
        ) : null}
        {explorerOpen ? (
          <PaneSplitter
            label={t("app.explorer.resize")}
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
            {sqlTabs.map((tab) => (
              <div
                key={tab}
                role="tab"
                className={activeTabId === tab ? "editor-tab sql-tab active" : "editor-tab sql-tab"}
                title={t("app.sqlTabs.renameHint")}
                onClick={() => focusTab(tab)}
                onDoubleClick={() => {
                  setFormError(null);
                  setDialog({ kind: "rename-sql-tab", tab });
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) closeSqlTab(tab);
                }}
              >
                {sqlMeta[tab]?.savedId ? <FileCode size={15} /> : <TerminalSquare size={15} />}
                <span className="tab-label">{sqlTabLabel(tab)}</span>
                {sqlDirty[tab] ? <span className="tab-dirty" aria-label={t("app.sqlTabs.modified")} title={t("app.sqlTabs.modified")}>•</span> : null}
                {sqlTabs.length > 1 ? (
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={t("app.tabs.close", { name: sqlTabLabel(tab) })}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeSqlTab(tab);
                    }}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            ))}
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
                  aria-label={t("app.tabs.close", { name: tab.table.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTable(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="icon-button new-tab" aria-label={t("app.sqlTabs.new")} title={t("app.sqlTabs.newTitle")} onClick={() => newSqlTab()}>
              <Plus size={15} />
            </button>
            <div className="editor-tab-actions">
              <button type="button" className="icon-button" aria-label={t("app.explorer.title")} onClick={() => setExplorerOpen((current) => !current)}>
                <PanelLeft size={16} />
              </button>
            </div>
          </div>
          {sqlTabs.map((tab) => {
            const sqlView = views[tab] ?? emptyView();
            return (
            <div key={tab} ref={(element) => { sqlStageRefs.current[tab] = element; }} className={activeTabId === tab ? "editor-stage" : "editor-stage pane-off"}>
              <div className="editor-toolbar">
                <span>SQL</span>
                <div>
                  <HistoryMenu
                    engine={engine}
                    entries={history}
                    onPick={(sql) => editorOf(tab)?.insertSql(sql)}
                    onStar={(id) => active && setHistory(toggleStar(active.id, id))}
                    onRemove={(id) => active && setHistory(removeHistory(active.id, id))}
                    onClear={() => active && setHistory(clearHistory(active.id))}
                  />
                  <button
                    type="button"
                    className="toolbar-button"
                    title={t("app.saved.saveTitle")}
                    disabled={!active}
                    onClick={() => {
                      setFormError(null);
                      setDialog({ kind: "save-query", tab });
                    }}
                  >
                    <Bookmark size={14} /> {t("app.saved.save")}
                  </button>
                  <button
                    type="button"
                    className="toolbar-button"
                    title={t("app.link.copyTitle")}
                    disabled={!active}
                    onClick={() => {
                      const sql = editorOf(tab)?.getValue().trim() ?? "";
                      if (!active || !sql) {
                        setStatus(tab, t("app.status.noSql"));
                        return;
                      }
                      void navigator.clipboard?.writeText(shareLink(active, sql, sqlMeta[tab]?.title)).then(() => setStatus(tab, t("app.link.copied")));
                    }}
                  >
                    <Link2 size={14} /> {t("app.link.copy")}
                  </button>
                  {engineInfo.tools.explain ? (
                    <button type="button" className="toolbar-button" title={t("app.plan.buttonTitle")} disabled={!active || running || busy} onClick={() => void explainQuery(tab)}>
                      <Route size={14} /> {t("app.plan.button")}
                    </button>
                  ) : null}
                  <button type="button" className="toolbar-button" title={t("app.editor.formatTitle")} onClick={() => formatEditor(tab)}>
                    <Braces size={14} /> {t("app.editor.format")} <kbd>{formatShortcut}</kbd>
                  </button>
                  <ExportMenu disabled={running || sqlView.columns.length === 0} onExport={(format) => void exportResult(tab, format)} />
                  <button
                    type="button"
                    className="toolbar-button"
                    title={t("app.editor.cancel")}
                    disabled={!running || runningTab.current !== tab}
                    onClick={() => {
                      const queryId = activeQuery.current;
                      if (queryId) void cancelQuery(queryId);
                    }}
                  >
                    <CircleStop size={14} /> {t("app.editor.cancel")}
                  </button>
                  <button type="button" className="toolbar-button" title={t("app.editor.runAllTitle")} disabled={!active || running || busy} onClick={() => runScript(tab)}>
                    <FastForward size={14} /> {t("app.editor.runAll")} <kbd>{runAllShortcut}</kbd>
                  </button>
                  <button type="button" className="run-button" title={t("app.editor.runTitle")} disabled={!active || running || busy} onClick={() => void runQuery(tab)}>
                    <Play size={14} /> {t("app.editor.run")} <kbd>{runShortcut}</kbd>
                  </button>
                </div>
              </div>
              <SqlEditor
                key={`${active?.id ?? ""}:${tab}`}
                ref={(handle) => { editorRefs.current[tab] = handle; }}
                engine={engine}
                schema={schema}
                initialSql={sqlSeeds.current[tab] ?? ""}
                visible={activeTabId === tab}
                onChange={(sql) => onSqlChange(tab, sql)}
                onRun={() => void runQuery(tab)}
                onRunAll={() => runScript(tab)}
                onFormat={() => formatEditor(tab)}
                onError={(error) => {
                  recordError("editor", error);
                  setStatus(tab, t("app.editor.failed", { message: editorFailure(error) }));
                }}
                checker={checker}
              />
              {sqlView.ran ? (
                <>
                  <PaneSplitter
                    axis="y"
                    label={t("app.editor.resizeResults")}
                    onDrag={(delta) =>
                      setResultsHeight((current) => {
                        const next = clampResults(current - delta, sqlStageRefs.current[tab] ?? null);
                        window.localStorage.setItem("gridl.results", String(next));
                        return next;
                      })
                    }
                  />
                  <div className="query-results" style={{ height: resultsHeight }}>
                    {sqlView.results && !sqlView.pending ? (
                      <div className="result-tabs" role="tablist" aria-label={t("app.results.label")}>
                        {sqlView.results.map((result, index) => (
                          <button
                            key={index}
                            type="button"
                            role="tab"
                            aria-selected={sqlView.shown === index}
                            className={`${sqlView.shown === index ? "active" : ""}${result.error ? " failed" : ""}`}
                            title={result.sql}
                            onClick={() => showResult(tab, index)}
                          >
                            {scriptResultLabel(result, index)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {sqlView.error ? (
                      <ErrorPanel error={sqlView.error} action={reconnectAction(sqlView.error)} />
                    ) : sqlView.plan ? (
                      <PlanView nodes={sqlView.plan} />
                    ) : sqlView.columns.length > 0 ? (
                      <ResultGrid
                        key={sqlView.shown ?? -1}
                        columns={sqlView.columns}
                        rowCount={sqlView.rowCount}
                        rowsRef={rowsHandle(tab)}
                        onFocusRow={(row) => setFocusedRow(row === null ? null : { tab, row })}
                        onCellMenu={(row, column, point, range) => setCellMenu({ tab, row, column, ...point, range })}
                      />
                    ) : (
                      <ResultMessage
                        loading={Boolean(sqlView.pending)}
                        text={sqlView.pending ? t("app.status.running") : (pickedWrite(sqlView) ?? sqlView.status)}
                      />
                    )}
                  </div>
                </>
              ) : null}
              <div className={sqlView.error ? "editor-status failed" : "editor-status"}>
                <span>{sqlView.status || t("app.empty.start")}</span>
                {sqlView.more && !running ? (
                  <button
                    type="button"
                    className="status-action"
                    title={t("app.editor.loadMoreTitle")}
                    onClick={() => {
                      const more = sqlView.more;
                      if (more) void runQuery(tab, more.sql, more.limit);
                    }}
                  >
                    {t("app.editor.loadMore", { count: formatNumber(sqlView.more.limit) })}
                  </button>
                ) : null}
              </div>
            </div>
            );
          })}
          {activeTable && tableView ? (
            <div className="results-stage">
              <div className="editor-toolbar">
                <div className="toolbar-title">
                  <span title={activeTable.table.schema ? `${activeTable.table.schema}.${activeTable.table.name}` : activeTable.table.name}>{activeTable.table.schema ? `${activeTable.table.schema}.${activeTable.table.name}` : activeTable.table.name}</span>
                  {structureTable && !structureLocked ? (
                    <div className="view-switch" role="tablist">
                      <button type="button" className={tablePane === "rows" ? "active" : undefined} onClick={() => setTablePane("rows")}>{t("app.table.data")}</button>
                      <button type="button" className={tablePane === "structure" ? "active" : undefined} onClick={() => setTablePane("structure")}>{t("app.table.structure")}</button>
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
                    {activeTable.table.kind === "table" ? (
                      <button type="button" className="toolbar-button" title={t("app.compare.buttonTitle")} onClick={() => setCompareOpen(true)}>
                        <GitCompareArrows size={14} /> {t("app.compare.button")}
                      </button>
                    ) : null}
                    <ExportMenu disabled={running || tableView.columns.length === 0} onExport={(format) => void exportResult(activeTable.id, format)} />
                    {writable ? (
                      <button type="button" className="toolbar-button" disabled={running} title={t("app.table.importTitle")} onClick={() => void startImport(activeTable.id, activeTable.table)}>
                        <Upload size={14} /> {t("app.table.import")}
                      </button>
                    ) : null}
                    <button type="button" className="toolbar-button" disabled={!writable || running || tableView.columns.length === 0} title={t("app.table.row")} onClick={startDraft}>
                      <Plus size={14} /> {t("app.table.row")}
                    </button>
                    <button type="button" className="toolbar-button" disabled={!writable || running || pickedRows.length === 0} title={t("app.table.delete")} onClick={() => markRows(pickedRows)}>
                      <Trash2 size={14} /> {t("app.table.delete")}
                    </button>
                    {pending[activeTable.id] || stashes[activeTable.id]?.length ? (
                      <>
                        <button type="button" className="toolbar-button" disabled={running} onClick={previewEdits}>
                          <Eye size={14} /> SQL
                        </button>
                        <button type="button" className="run-button" disabled={running} onClick={() => void saveEdits()}>
                          {t("app.table.save")} <kbd>{saveShortcut}</kbd>
                        </button>
                        <button type="button" className="toolbar-button" title={t("app.table.cancel")} disabled={running} onClick={discardEdits}>
                          <Undo2 size={14} /> {t("app.table.cancel")}
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : showsRows(activeTable.table) ? null : (
                  <div>
                    <span className="toolbar-kind">{kindLabel(activeTable.table.kind)}</span>
                    {activeTable.table.definition ? (
                      <CopyButton text={activeTable.table.definition} label={t("app.definition.copy")} title={t("app.definition.copyTitle")} />
                    ) : null}
                  </div>
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
                    layoutKey={active ? `${active.id}:${activeTable.id}` : undefined}
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
                  tableView.error ? (
                    <ErrorPanel error={tableView.error} action={reconnectAction(tableView.error)} />
                  ) : (
                    <div className="results-empty">
                      {running && runningTab.current === activeTable.id ? <LogoLoader label={tableView.status || t("app.status.loading")} /> : tableView.status || t("app.status.loading")}
                    </div>
                  )
                )
              ) : (
                <>
                  {activeTable.table.kind === "function" || activeTable.table.kind === "procedure" ? (
                    <RoutineSummary
                      routine={activeTable.table}
                      onUse={() => {
                        setActiveTabId(lastSqlTab.current);
                        editorOf()?.insertSql(routineCallSql(activeTable.table, engine));
                      }}
                    />
                  ) : null}
                  {activeTable.table.definition ? (
                    <SqlDefinition sql={activeTable.table.definition} engine={engine} />
                  ) : (
                    <pre className="definition-view">{t("app.definition.none")}</pre>
                  )}
                </>
              )}
              {tablePane === "structure" && structureTable && !structureLocked ? null : !writable && showsRows(activeTable.table) ? (
                <div className="editor-status">
                  <span>{active?.readOnly ? t("app.table.readOnly") : safety.writes === "block" ? t("app.table.policyBlocks", { environment: environmentLabel(safety.environment) }) : activeTable.table.kind !== "table" ? t("app.table.viewsReadOnly") : t("app.table.noPrimaryKey")}</span>
                </div>
              ) : null}
              {tablePane === "structure" && structureTable && !structureLocked ? null : showsRows(activeTable.table) ? (
                <>
                  <TablePager
                    page={paging[activeTable.id]}
                    running={running}
                    onPage={(page) => void loadTable(activeTable.table, page, paging[activeTable.id]?.pageSize ?? 100, false, false, false, true)}
                    onPageSize={(pageSize) => void loadTable(activeTable.table, 0, pageSize, false, false, false, true)}
                    onCount={() => {
                      const shown = paging[activeTable.id];
                      if (!shown) return;
                      const query = tableQueryRef.current[activeTable.id];
                      const token = (loadToken.current[activeTable.id] ?? 0) + 1;
                      loadToken.current[activeTable.id] = token;
                      const counting: TablePage = { ...shown, total: null, approximate: false };
                      const where = whereClause(query?.filters ?? [], engine);
                      setPaging((current) => ({ ...current, [activeTable.id]: counting }));
                      setViews((current) => (current[activeTable.id] ? { ...current, [activeTable.id]: { ...current[activeTable.id], status: pageStatus(counting, Boolean(where), 0) } } : current));
                      void countRows(activeTable.table, counting, where, 0, token, true);
                    }}
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
          label={t("app.details.resize")}
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
            <span>{t("app.details.row")}</span>
          </div>
          {focusedValues !== null && focusedRow && focusView ? (
            <RowDetails
              columns={focusView.columns}
              row={focusedValues}
              index={focusedRow.row}
              relation={(column) => {
                const source = activeTable?.table;
                if (!source || isSqlTab(focusedRow.tab)) return null;
                const key = keyForColumn(foreignKeys, source, column);
                if (!key || !findTable(tables, key.refSchema, key.refTable)) return null;
                return { label: key.refTable, open: () => openReferenced(key, focusView.columns, focusedValues) };
              }}
              onEdit={activeTable && focusedRow.tab === activeTable.id && writable ? (column, value) => editCell(focusedRow.row, column, value) : undefined}
            />
          ) : (
            <div className="details-empty">
              <div className="details-orb">
                <Database size={22} />
              </div>
              <strong>{t("app.details.emptyTitle")}</strong>
              <span>{t("app.details.emptyBody")}</span>
            </div>
          )}
        </aside>
      </div>
      {paramPrompt && active ? (
        <ParamsDialog
          connectionId={active.id}
          names={paramPrompt.names}
          onClose={() => setParamPrompt(null)}
          onRun={(values) => {
            const prompt = paramPrompt;
            setParamPrompt(null);
            void runQuery(prompt.tabId, prompt.statements, prompt.maxRows, values);
          }}
        />
      ) : null}
      {compareOpen && activeTable && activeTable.table.kind === "table" ? (
        <CompareView
          engine={engine}
          table={activeTable.table}
          tables={tables}
          query={async (sql) => (await collectQuery(sql))?.rows ?? []}
          onClose={() => setCompareOpen(false)}
        />
      ) : null}
      {diagramOpen ? (
        <ErDiagram
          title={engineInfo.structure.schemas && !allSchemas ? activeSchema : (active?.database ?? "")}
          tables={engineInfo.structure.schemas && !allSchemas ? tables.filter((table) => table.schema === activeSchema) : tables}
          keys={foreignKeys}
          onOpen={(table) => {
            setDiagramOpen(false);
            openTable(table, true);
          }}
          onClose={() => setDiagramOpen(false)}
        />
      ) : null}
      {quickOpen ? <QuickOpen objects={tables} onOpen={(object) => openTable(object, true)} onClose={() => setQuickOpen(false)} /> : null}
      {dialog?.kind === "save-query" ? (
        <NameDialog
          title={t("app.saved.dialogTitle")}
          description={t("app.saved.dialogBody")}
          initial={sqlMeta[dialog.tab]?.title || suggestedName(editorOf(dialog.tab)?.getValue() ?? "")}
          confirmLabel={t("app.saved.save")}
          busy={false}
          error={formError}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const sql = editorOf(dialog.tab)?.getValue().trim() ?? "";
            if (!active || !name.trim()) return;
            if (!sql) {
              setFormError(t("app.saved.empty"));
              return;
            }
            const next = sharedConnection ? withSaved(savedQueries, name.trim(), sql) : saveQuery(active.id, name.trim(), sql);
            if (sharedConnection) void teamSaveQueries(active.id, next).then(setTeam).catch((caught: unknown) => setFormError(errorMessage(caught)));
            else setSavedQueries(next);
            const saved = next.find((query) => query.name === name.trim());
            if (saved) {
              // Other tabs that held a query of the same name now hold nothing saved.
              setSqlMeta((current) => {
                const updated = Object.fromEntries(Object.entries(current).map(([id, meta]) => [id, meta.savedId && !next.some((query) => query.id === meta.savedId) ? { title: meta.title } : meta]));
                return { ...updated, [dialog.tab]: { title: saved.name, savedId: saved.id } };
              });
              setSqlDirty((current) => ({ ...current, [dialog.tab]: false }));
            }
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "rename-sql-tab" ? (
        <NameDialog
          title={t("app.sqlTabs.renameTitle")}
          description={t("app.sqlTabs.renameBody")}
          initial={sqlMeta[dialog.tab]?.title ?? ""}
          confirmLabel={t("app.sqlTabs.rename")}
          busy={false}
          error={null}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const title = name.trim() || undefined;
            setSqlMeta((current) => ({ ...current, [dialog.tab]: { ...current[dialog.tab], title } }));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "create-schema" ? (
        <NameDialog title={t("app.schema.newTitle")} description={t("app.schema.newDescription")} initial="" confirmLabel={t("app.schema.create")} busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name) => void submitName(name)} />
      ) : null}
      {dialog?.kind === "rename-schema" ? (
        <NameDialog title={t("app.schema.renameTitle")} description={t("app.schema.renameDescription", { name: dialog.name })} initial={dialog.name} confirmLabel={t("app.schema.rename")} busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name) => void submitName(name)} />
      ) : null}
      {dialog?.kind === "drop-schema" ? (
        <ConfirmDialog title={t("app.schema.dropTitle")} description={t("app.schema.dropDescription", { name: dialog.name })} confirmLabel={t("app.schema.drop")} busy={running} error={formError} onClose={() => setDialog(null)} onConfirm={() => void submitDropSchema()} />
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
        <TableDialog engine={engine} schema={engineInfo.structure.schemas ? activeSchema : null} tables={tables} busy={running} error={formError} onClose={() => setDialog(null)} onSubmit={(name, columns) => void submitTable(name, columns)} />
      ) : null}
    </div>
  );
}

async function readSchemas(connectionId: string, engine: DatabaseEngine): Promise<string[]> {
  const sql = listSchemasSql(engine);
  if (!sql) return [];
  const names: string[] = [];
  await executeQuery(
    { connectionId, queryId: crypto.randomUUID(), sql, params: [], chunkRows: 200 },
    (chunk) => {
      for (const row of chunk.rows) {
        const name = schemaNameFrom(row[0]);
        if (name) names.push(name);
      }
    },
  );
  return names;
}

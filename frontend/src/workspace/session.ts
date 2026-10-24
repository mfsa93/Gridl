import { type TableSchema } from "../lib/api";
import { isSqlTab, sqlTabId, tableTabId, type TableTab } from "./model";

export type SavedTab = {
  schema: string | null;
  name: string;
  kind: TableSchema["kind"];
  pinned: boolean;
};

export type SavedSqlTab = {
  id: string;
  sql: string;
  /** A name the user gave the tab, or the saved query it was opened from. */
  title?: string;
  /** The saved query the tab holds, so opening it again comes back to this tab. */
  savedId?: string;
};

export type SavedSession = {
  /** Text of the first SQL tab; kept for sessions saved before there were several. */
  sql: string;
  /** Every SQL tab in order, with its text. */
  sqlTabs?: SavedSqlTab[];
  activeTab: string;
  tabs: SavedTab[];
};

export function sessionKey(id: string) {
  return `gridl.session.${id}`;
}

export function workspaceTabs(tabs: TableTab[]): SavedTab[] {
  return tabs.map((tab) => ({
    schema: tab.table.schema,
    name: tab.table.name,
    kind: tab.table.kind,
    pinned: tab.pinned,
  }));
}

export function readSession(id: string): SavedSession | null {
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
    const sqlTabs = Array.isArray(parsed.sqlTabs)
      ? parsed.sqlTabs.flatMap((tab) => (tab && typeof tab.id === "string" && isSqlTab(tab.id) && typeof tab.sql === "string"
        ? [{ id: tab.id, sql: tab.sql, title: typeof tab.title === "string" ? tab.title : undefined, savedId: typeof tab.savedId === "string" ? tab.savedId : undefined }]
        : []))
      : [];
    return {
      sql: parsed.sql,
      sqlTabs: sqlTabs.length > 0 ? sqlTabs : [{ id: sqlTabId, sql: parsed.sql }],
      activeTab: typeof parsed.activeTab === "string" ? parsed.activeTab : sqlTabId,
      tabs,
    };
  } catch {
    return null;
  }
}

export function writeSession(id: string, session: SavedSession) {
  try {
    const cap = (sql: string) => (sql.length > 500_000 ? sql.slice(0, 500_000) : sql);
    const sqlTabs = session.sqlTabs?.map((tab) => ({ ...tab, sql: cap(tab.sql) }));
    window.localStorage.setItem(sessionKey(id), JSON.stringify({ ...session, sql: cap(session.sql), sqlTabs }));
  } catch {
    // The browser can reject the write when storage is full.
  }
}

export function matchTabs(saved: SavedSession | null, tables: TableSchema[]): TableTab[] {
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

export function readPaneWidth(key: string, fallback: number) {
  const stored = window.localStorage.getItem(key);
  const value = stored === null ? Number.NaN : Number(stored);
  return Number.isFinite(value) && value > 0 ? clampPane(value, 200, 640) : fallback;
}

export function readResultsHeight() {
  const stored = window.localStorage.getItem("gridl.results");
  const value = stored === null ? Number.NaN : Number(stored);
  return Number.isFinite(value) && value > 0 ? Math.max(120, value) : 320;
}

export function clampResults(value: number, stage: HTMLDivElement | null) {
  const total = stage?.clientHeight ?? 720;
  const max = Math.max(120, total - 180);
  return Math.min(Math.max(value, 120), max);
}

export function clampPane(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function paneLimit(body: HTMLDivElement | null, other: number) {
  const total = body?.clientWidth ?? 1100;
  return total - other - 420;
}

export type SchemaView = { schema: string; all: boolean };

function schemaViewKey(id: string): string {
  return `gridl.schemaView:${id}`;
}

/** Which schema the explorer showed last time for this connection. */
export function readSchemaView(id: string): SchemaView {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(schemaViewKey(id)) ?? "null") as Partial<SchemaView> | null;
    return {
      schema: typeof parsed?.schema === "string" && parsed.schema ? parsed.schema : "public",
      all: parsed?.all === true,
    };
  } catch {
    return { schema: "public", all: false };
  }
}

export function writeSchemaView(id: string, view: SchemaView) {
  try {
    window.localStorage.setItem(schemaViewKey(id), JSON.stringify(view));
  } catch {
    // Only a convenience; the explorer falls back to public.
  }
}

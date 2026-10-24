import type { TableSchema } from "../lib/api";
import type { TableQuery } from "./model";

/** What a table tab keeps between visits: its filters, sort and page size. */
export type TableState = TableQuery & { pageSize?: number };

function stateKey(connectionId: string) {
  return `gridl.tables.${connectionId}`;
}

function readAll(connectionId: string): Record<string, TableState> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(stateKey(connectionId)) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, TableState>) : {};
  } catch {
    return {};
  }
}

/** The saved state of a table, without filters or a sort on columns it no longer has. */
export function readTableState(connectionId: string, id: string, table: TableSchema): TableState | null {
  const saved = readAll(connectionId)[id];
  if (!saved || !Array.isArray(saved.filters)) return null;
  const names = new Set(table.columns.map((column) => column.name));
  return {
    filters: saved.filters.filter((filter) => names.has(filter.column)),
    sort: saved.sort && names.has(saved.sort.column) ? saved.sort : null,
    pageSize: typeof saved.pageSize === "number" ? saved.pageSize : undefined,
  };
}

/** Saves the given tables' state; tables back to the defaults are forgotten. */
export function writeTableStates(connectionId: string, states: Record<string, TableState>) {
  const all = readAll(connectionId);
  for (const [id, state] of Object.entries(states)) {
    const plain = state.filters.length === 0 && !state.sort && (state.pageSize === undefined || state.pageSize === 100);
    if (plain) delete all[id];
    else all[id] = state;
  }
  try {
    window.localStorage.setItem(stateKey(connectionId), JSON.stringify(all));
  } catch {
    // Storage can be full or blocked; this is a convenience.
  }
}

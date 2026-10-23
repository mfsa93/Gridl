export type HistoryEntry = {
  id: string;
  sql: string;
  at: number;
  durationMs: number | null;
  ok: boolean;
  starred: boolean;
};

const historyLimit = 200;

function historyKey(connectionId: string) {
  return `gridl.history.${connectionId}`;
}

export function readHistory(connectionId: string): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyKey(connectionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is HistoryEntry => (
      typeof item === "object" && item !== null && typeof item.sql === "string" && typeof item.at === "number"
    )).map((item) => ({ ...item, id: item.id ?? crypto.randomUUID(), starred: Boolean(item.starred) }));
  } catch {
    return [];
  }
}

function writeHistory(connectionId: string, entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(historyKey(connectionId), JSON.stringify(entries));
  } catch {
    // Storage can be full or blocked; history is a convenience.
  }
}

/** Records a run. Repeating the newest statement updates it instead of adding a copy. */
export function pushHistory(connectionId: string, entry: Omit<HistoryEntry, "id" | "starred">): HistoryEntry[] {
  const current = readHistory(connectionId);
  const previous = current[0];
  let next: HistoryEntry[];
  if (previous && previous.sql === entry.sql) {
    next = [{ ...previous, ...entry }, ...current.slice(1)];
  } else {
    next = [{ ...entry, id: crypto.randomUUID(), starred: false }, ...current];
  }
  let unstarred = 0;
  next = next.filter((item) => item.starred || (unstarred += 1) <= historyLimit);
  writeHistory(connectionId, next);
  return next;
}

export function toggleStar(connectionId: string, id: string): HistoryEntry[] {
  const next = readHistory(connectionId).map((item) => (item.id === id ? { ...item, starred: !item.starred } : item));
  writeHistory(connectionId, next);
  return next;
}

export function removeHistory(connectionId: string, id: string): HistoryEntry[] {
  const next = readHistory(connectionId).filter((item) => item.id !== id);
  writeHistory(connectionId, next);
  return next;
}

/** Drops everything except starred queries. */
export function clearHistory(connectionId: string): HistoryEntry[] {
  const next = readHistory(connectionId).filter((item) => item.starred);
  writeHistory(connectionId, next);
  return next;
}

export function forgetHistory(connectionId: string) {
  try {
    window.localStorage.removeItem(historyKey(connectionId));
  } catch {
    // Ignore blocked storage.
  }
}

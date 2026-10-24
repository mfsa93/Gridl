/** A query the user kept under a name, per connection. */
export type SavedQuery = {
  id: string;
  name: string;
  sql: string;
  at: number;
};

function savedKey(connectionId: string) {
  return `gridl.saved.${connectionId}`;
}

export function readSaved(connectionId: string): SavedQuery[] {
  try {
    const raw = window.localStorage.getItem(savedKey(connectionId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedQuery => (
      typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.name === "string" && typeof item.sql === "string"
    ));
  } catch {
    return [];
  }
}

function writeSaved(connectionId: string, queries: SavedQuery[]): SavedQuery[] {
  try {
    window.localStorage.setItem(savedKey(connectionId), JSON.stringify(queries));
  } catch {
    // Storage can be full or blocked.
  }
  return queries;
}

/** `queries` with `sql` saved as `name`; a query with the same name keeps its id and is replaced. Sorted by name. */
export function withSaved(queries: SavedQuery[], name: string, sql: string): SavedQuery[] {
  const same = queries.find((query) => query.name.toLowerCase() === name.toLowerCase());
  const others = queries.filter((query) => query !== same);
  return [...others, { id: same?.id ?? crypto.randomUUID(), name, sql, at: Date.now() }].sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves `sql` as `name` for this Mac only. */
export function saveQuery(connectionId: string, name: string, sql: string): SavedQuery[] {
  return writeSaved(connectionId, withSaved(readSaved(connectionId), name, sql));
}

export function removeSaved(connectionId: string, id: string): SavedQuery[] {
  return writeSaved(connectionId, readSaved(connectionId).filter((query) => query.id !== id));
}

/** A name to start from: the first line of the SQL, trimmed to a readable length. */
export function suggestedName(sql: string): string {
  const line = sql.trim().split("\n")[0]?.replace(/\s+/g, " ").replace(/;$/, "") ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

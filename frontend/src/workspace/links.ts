import type { ConnectionConfig } from "../lib/api";

/** What a gridl:// link opens: a connection and SQL for a new tab. */
export type OpenLink = { connection: string; name: string; sql: string; title: string };

/** A link that opens `sql` in a new tab of `connection`. Running it stays up to the reader. */
export function shareLink(connection: ConnectionConfig, sql: string, title?: string): string {
  const query = new URLSearchParams({ connection: connection.id, name: connection.name, sql });
  if (title) query.set("title", title);
  return `gridl://open?${query.toString()}`;
}

export function parseLink(text: string): OpenLink | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "gridl:" || url.hostname !== "open") return null;
    const read = (key: string) => url.searchParams.get(key) ?? "";
    return { connection: read("connection"), name: read("name"), sql: read("sql"), title: read("title") };
  } catch {
    return null;
  }
}

/**
 * The saved connection a link points at: the same id when the teams share
 * profiles, otherwise the one with the same name.
 */
export function linkTarget(link: OpenLink, profiles: ConnectionConfig[]): ConnectionConfig | null {
  return profiles.find((profile) => profile.id === link.connection)
    ?? profiles.find((profile) => profile.name.trim().toLowerCase() === link.name.trim().toLowerCase())
    ?? null;
}

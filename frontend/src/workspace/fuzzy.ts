import type { TableSchema } from "../lib/api";

/**
 * Scores `name` against what was typed: the letters must appear in order.
 * A match at the start, at a word start (after _ . or a capital), or in a
 * contiguous run scores higher; null means no match.
 */
export function fuzzyScore(query: string, name: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return 0;
  const hay = name.toLowerCase();
  const direct = hay.indexOf(needle);
  if (direct === 0) return 1000 - name.length;
  if (direct > 0) return 800 - direct - name.length;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of needle) {
    const at = hay.indexOf(letter, from);
    if (at < 0) return null;
    const boundary = at === 0 || "_.- ".includes(hay[at - 1] ?? "") || (name[at] !== hay[at] && name[at - 1] === hay[at - 1]);
    score += at === previous + 1 ? 8 : boundary ? 6 : 1;
    previous = at;
    from = at + 1;
  }
  return score * 10 - name.length;
}

/** The best matches for the quick-open box, tables before other objects on a tie. */
export function quickMatches(objects: TableSchema[], query: string, limit = 60): TableSchema[] {
  const rank = (kind: TableSchema["kind"]) => (kind === "table" ? 0 : kind === "view" || kind === "materialized" ? 1 : 2);
  return objects
    .flatMap((object) => {
      const plain = fuzzyScore(query, object.name);
      const qualified = object.schema ? fuzzyScore(query, `${object.schema}.${object.name}`) : null;
      const score = Math.max(plain ?? -Infinity, qualified === null ? -Infinity : qualified - 50);
      return Number.isFinite(score) ? [{ object, score }] : [];
    })
    .sort((a, b) => b.score - a.score || rank(a.object.kind) - rank(b.object.kind) || a.object.name.localeCompare(b.object.name))
    .slice(0, limit)
    .map((match) => match.object);
}

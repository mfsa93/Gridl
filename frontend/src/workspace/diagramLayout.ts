import type { ForeignKey, TableSchema } from "../lib/api";

export const boxWidth = 230;
export const headerHeight = 30;
export const rowHeight = 21;
const gapX = 90;
const gapY = 36;

export type Placed = { key: string; table: TableSchema; x: number; y: number; height: number };
export type Edge = { from: string; to: string; fromColumn: string; toColumn: string; name: string };

export const tableKey = (schema: string | null, name: string) => `${schema ?? ""}.${name}`;

export function boxHeight(table: TableSchema): number {
  return headerHeight + Math.max(1, table.columns.length) * rowHeight + 6;
}

/** Foreign keys between the given tables, one edge per key. */
export function diagramEdges(tables: TableSchema[], keys: ForeignKey[]): Edge[] {
  const known = new Set(tables.map((table) => tableKey(table.schema, table.name)));
  return keys.flatMap((key) => {
    const from = tableKey(key.schema, key.table);
    const to = tableKey(key.refSchema, key.refTable);
    if (!known.has(from) || !known.has(to)) return [];
    return [{ from, to, fromColumn: key.columns[0] ?? "", toColumn: key.refColumns[0] ?? "", name: key.name }];
  });
}

/**
 * Lays tables out in columns: each group of related tables starts from its
 * most referenced table and spreads outward by distance, so a key mostly runs
 * between neighbouring columns. Tables without keys fill a grid at the end.
 */
export function layoutDiagram(tables: TableSchema[], edges: Edge[]): Placed[] {
  const keyOf = (table: TableSchema) => tableKey(table.schema, table.name);
  const neighbours = new Map<string, Set<string>>();
  for (const table of tables) neighbours.set(keyOf(table), new Set());
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    neighbours.get(edge.from)?.add(edge.to);
    neighbours.get(edge.to)?.add(edge.from);
  }
  const byKey = new Map(tables.map((table) => [keyOf(table), table]));
  const degree = (key: string) => neighbours.get(key)?.size ?? 0;
  const placed: Placed[] = [];
  const seen = new Set<string>();
  let originX = 0;
  const related = tables.map(keyOf).filter((key) => degree(key) > 0).sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
  for (const root of related) {
    if (seen.has(root)) continue;
    // Breadth-first layers from the most connected table of this group.
    const layers: string[][] = [];
    let frontier = [root];
    seen.add(root);
    while (frontier.length > 0) {
      layers.push(frontier);
      const next: string[] = [];
      for (const key of frontier) {
        for (const other of [...(neighbours.get(key) ?? [])].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))) {
          if (seen.has(other)) continue;
          seen.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    layers.forEach((layer, column) => {
      let y = 0;
      for (const key of layer) {
        const table = byKey.get(key);
        if (!table) continue;
        const height = boxHeight(table);
        placed.push({ key, table, x: originX + column * (boxWidth + gapX), y, height });
        y += height + gapY;
      }
    });
    originX += layers.length * (boxWidth + gapX) + gapX;
  }
  // Tables with no keys: a grid to the right, in name order.
  const lonely = tables.filter((table) => !seen.has(keyOf(table))).sort((a, b) => a.name.localeCompare(b.name));
  const perColumn = Math.max(1, Math.ceil(Math.sqrt(lonely.length)));
  lonely.forEach((table, index) => {
    const column = Math.floor(index / perColumn);
    const above = lonely.slice(column * perColumn, index).reduce((sum, item) => sum + boxHeight(item) + gapY, 0);
    placed.push({ key: keyOf(table), table, x: originX + column * (boxWidth + gapX), y: above, height: boxHeight(table) });
  });
  return placed;
}

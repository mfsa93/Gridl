import { engineSpec } from "../engines";
import { t } from "../lib/i18n";
import { quoteIdent, qualifiedName, type DatabaseEngine, type ForeignKey, type TableSchema } from "../lib/api";

export const fkActions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;
export type FkAction = (typeof fkActions)[number];

export type NewForeignKey = {
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
};

function sameTable(schema: string | null, name: string, table: TableSchema): boolean {
  return table.name === name && (table.schema ?? null) === (schema ?? null);
}

/** Keys declared on `table`. */
export function outgoingKeys(keys: ForeignKey[], table: TableSchema): ForeignKey[] {
  return keys.filter((key) => sameTable(key.schema, key.table, table));
}

/** Keys on other tables that point at `table`. */
export function incomingKeys(keys: ForeignKey[], table: TableSchema): ForeignKey[] {
  return keys.filter((key) => sameTable(key.refSchema, key.refTable, table));
}

export function findTable(tables: TableSchema[], schema: string | null, name: string): TableSchema | null {
  return tables.find((table) => table.kind === "table" && sameTable(schema, name, table)) ?? null;
}

/** Referenced columns, falling back to the referenced table's primary key when the catalog leaves them implicit. */
export function resolvedRefColumns(key: ForeignKey, tables: TableSchema[]): string[] {
  if (key.refColumns.length > 0) return key.refColumns;
  const target = findTable(tables, key.refSchema, key.refTable);
  return target ? target.columns.filter((column) => column.primaryKey).map((column) => column.name) : [];
}

/** The single-column key that starts at `column`, if any. */
export function keyForColumn(keys: ForeignKey[], table: TableSchema, column: string): ForeignKey | null {
  return outgoingKeys(keys, table).find((key) => key.columns.includes(column)) ?? null;
}

export function refLabel(key: ForeignKey, tables: TableSchema[]): string {
  const target = key.refSchema && key.refSchema !== "public" && key.refSchema !== key.schema
    ? `${key.refSchema}.${key.refTable}`
    : key.refTable;
  const columns = resolvedRefColumns(key, tables);
  return columns.length > 0 ? `${target} (${columns.join(", ")})` : target;
}

function refTarget(schema: string | null, table: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table);
}

/** `foreign key (...) references ...`, shared by CREATE TABLE and ALTER TABLE. */
export function foreignKeyClause(key: NewForeignKey): string {
  if (key.columns.length === 0) throw new Error(t("relations.pickColumn"));
  if (key.refColumns.length !== key.columns.length) throw new Error(t("relations.pickReferenced"));
  const parts = [
    `foreign key (${key.columns.map(quoteIdent).join(", ")})`,
    `references ${refTarget(key.refSchema, key.refTable)} (${key.refColumns.map(quoteIdent).join(", ")})`,
  ];
  if (key.onDelete !== "NO ACTION") parts.push(`on delete ${key.onDelete.toLowerCase()}`);
  if (key.onUpdate !== "NO ACTION") parts.push(`on update ${key.onUpdate.toLowerCase()}`);
  return parts.join(" ");
}

export function foreignKeyName(table: string, columns: string[]): string {
  return `${table}_${columns.join("_")}_fkey`.slice(0, 63);
}

export function addForeignKeySql(engine: DatabaseEngine, table: TableSchema, key: NewForeignKey): string {
  if (!engineSpec(engine).structure.alterForeignKeys) throw new Error(t("relations.noAdd", { engine: engineSpec(engine).name }));
  const name = quoteIdent(foreignKeyName(table.name, key.columns));
  return `alter table ${qualifiedName(table)} add constraint ${name} ${foreignKeyClause(key)}`;
}

export function dropForeignKeySql(engine: DatabaseEngine, table: TableSchema, name: string): string {
  if (!engineSpec(engine).structure.alterForeignKeys) throw new Error(t("relations.noDrop", { engine: engineSpec(engine).name }));
  const verb = engineSpec(engine).structure.dropForeignKey;
  return `alter table ${qualifiedName(table)} ${verb} ${quoteIdent(name)}`;
}

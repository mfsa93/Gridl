import { ArrowUpRight, Minus, Plus } from "lucide-react";
import { useState } from "react";
import type { DatabaseEngine, ForeignKey, TableSchema } from "../lib/api";
import {
  addForeignKeySql,
  dropForeignKeySql,
  fkActions,
  incomingKeys,
  outgoingKeys,
  refLabel,
  type FkAction,
} from "./relations";

type Draft = {
  column: string;
  target: string;
  refColumn: string;
  onDelete: FkAction;
  onUpdate: FkAction;
};

function tableKey(table: TableSchema): string {
  return `${table.schema ?? ""}\u0000${table.name}`;
}

function tableLabel(table: TableSchema, current: TableSchema): string {
  return table.schema && table.schema !== current.schema ? `${table.schema}.${table.name}` : table.name;
}

function firstKey(table: TableSchema | undefined): string {
  return table?.columns.find((column) => column.primaryKey)?.name ?? table?.columns[0]?.name ?? "";
}

/** Foreign keys of one table: the ones it declares, and the ones pointing at it. */
export function RelationsPanel({
  engine,
  table,
  tables,
  keys,
  busy,
  editable,
  onApply,
  onOpenTable,
}: {
  engine: DatabaseEngine;
  table: TableSchema;
  tables: TableSchema[];
  keys: ForeignKey[];
  busy: boolean;
  editable: boolean;
  onApply: (statements: string[]) => void;
  onOpenTable: (schema: string | null, name: string) => void;
}) {
  const outgoing = outgoingKeys(keys, table);
  const incoming = incomingKeys(keys, table);
  const targets = tables.filter((item) => item.kind === "table");
  const canAlter = editable && engine !== "sqlite";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const target = draft ? targets.find((item) => tableKey(item) === draft.target) : undefined;

  const startDraft = () => {
    const first = targets.find((item) => tableKey(item) !== tableKey(table)) ?? targets[0];
    setProblem(null);
    setDraft({
      column: table.columns[0]?.name ?? "",
      target: first ? tableKey(first) : "",
      refColumn: firstKey(first),
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
    });
  };

  const submit = () => {
    if (!draft || !target) return;
    try {
      const sql = addForeignKeySql(engine, table, {
        columns: [draft.column],
        refSchema: target.schema,
        refTable: target.name,
        refColumns: [draft.refColumn],
        onDelete: draft.onDelete,
        onUpdate: draft.onUpdate,
      });
      setProblem(null);
      setDraft(null);
      onApply([sql]);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="relations-panel">
      <div className="relations-title">
        <span>Relaciones</span>
        {engine === "sqlite" && editable ? <small>SQLite solo permite definirlas al crear la tabla.</small> : null}
      </div>
      <div className="relation-group">
        <div className="relation-head">
          <span>Columnas</span>
          <span>Referencia</span>
          <span>Al borrar</span>
          <span>Al actualizar</span>
          <span />
        </div>
        {outgoing.length === 0 && !draft ? <div className="relation-empty">Esta tabla no referencia a otras.</div> : null}
        {outgoing.map((key) => (
          <div className="relation-row" key={key.name}>
            <span className="mono">{key.columns.join(", ")}</span>
            <button type="button" className="relation-link" title={`Abrir ${key.refTable}`} onClick={() => onOpenTable(key.refSchema, key.refTable)}>
              {refLabel(key, tables)} <ArrowUpRight size={12} />
            </button>
            <span>{key.onDelete}</span>
            <span>{key.onUpdate}</span>
            <button
              type="button"
              className="tiny-icon"
              aria-label={`Quitar ${key.name}`}
              title={key.name}
              disabled={!canAlter || busy}
              onClick={() => onApply([dropForeignKeySql(engine, table, key.name)])}
            >
              <Minus size={14} />
            </button>
          </div>
        ))}
        {draft ? (
          <div className="relation-row relation-draft">
            <select value={draft.column} aria-label="Columna" onChange={(event) => setDraft({ ...draft, column: event.target.value })}>
              {table.columns.map((column) => (
                <option key={column.name} value={column.name}>{column.name}</option>
              ))}
            </select>
            <div className="relation-target">
              <select
                value={draft.target}
                aria-label="Tabla referenciada"
                onChange={(event) => {
                  const next = targets.find((item) => tableKey(item) === event.target.value);
                  setDraft({ ...draft, target: event.target.value, refColumn: firstKey(next) });
                }}
              >
                {targets.map((item) => (
                  <option key={tableKey(item)} value={tableKey(item)}>{tableLabel(item, table)}</option>
                ))}
              </select>
              <select value={draft.refColumn} aria-label="Columna referenciada" onChange={(event) => setDraft({ ...draft, refColumn: event.target.value })}>
                {(target?.columns ?? []).map((column) => (
                  <option key={column.name} value={column.name}>{column.name}{column.primaryKey ? " (pk)" : ""}</option>
                ))}
              </select>
            </div>
            <select value={draft.onDelete} aria-label="Al borrar" onChange={(event) => setDraft({ ...draft, onDelete: event.target.value as FkAction })}>
              {fkActions.map((action) => <option key={action} value={action}>{action}</option>)}
            </select>
            <select value={draft.onUpdate} aria-label="Al actualizar" onChange={(event) => setDraft({ ...draft, onUpdate: event.target.value as FkAction })}>
              {fkActions.map((action) => <option key={action} value={action}>{action}</option>)}
            </select>
            <span />
          </div>
        ) : null}
      </div>
      <div className="group-actions">
        {draft ? (
          <>
            <button type="button" className="toolbar-button" onClick={() => setDraft(null)}>Cancelar</button>
            <button type="button" className="run-button" disabled={busy || !target} onClick={submit}>Agregar relación</button>
          </>
        ) : (
          <button type="button" className="tiny-icon" aria-label="Agregar relación" title="Agregar relación" disabled={!canAlter || busy || targets.length === 0} onClick={startDraft}>
            <Plus size={14} />
          </button>
        )}
        {problem ? <span className="relation-problem">{problem}</span> : null}
      </div>

      <div className="relations-title">
        <span>Referenciada por</span>
      </div>
      {incoming.length === 0 ? (
        <div className="relation-empty plain">Ninguna tabla apunta a esta.</div>
      ) : (
        <div className="relation-group">
          {incoming.map((key) => (
            <div className="relation-row incoming" key={`${key.table}:${key.name}`}>
              <button type="button" className="relation-link" onClick={() => onOpenTable(key.schema, key.table)}>
                {key.schema && key.schema !== table.schema ? `${key.schema}.${key.table}` : key.table} <ArrowUpRight size={12} />
              </button>
              <span className="mono">por {key.columns.join(", ")}</span>
              <span>{key.onDelete === "NO ACTION" ? "" : `al borrar ${key.onDelete.toLowerCase()}`}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

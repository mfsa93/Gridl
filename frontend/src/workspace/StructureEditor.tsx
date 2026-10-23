import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type DatabaseEngine, type TableSchema } from "../lib/api";
import {
  blankColumnDraft,
  columnChangeSql,
  columnDraftDirty,
  columnDrafts,
  columnTypeSpecs,
  type ColumnDraft,
} from "./changes";

type StructureEditorProps = {
  table: TableSchema;
  engine: DatabaseEngine;
  busy: boolean;
  error: string | null;
  onApply: (statements: string[]) => Promise<void>;
  /** Column edits kept from an earlier visit to this table, if any. */
  draft?: ColumnDraft[] | null;
  /** Reports the unapplied column edits, or null when there are none. */
  onDraftChange?: (rows: ColumnDraft[] | null) => void;
};

export function StructureEditor({ table, engine, busy, error, onApply, draft, onDraftChange }: StructureEditorProps) {
  const [rows, setRows] = useState(() => draft ?? columnDrafts(table, engine));
  const [extraKey, setExtraKey] = useState(() => crypto.randomUUID());
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const specs = columnTypeSpecs(engine);
  const phantom = blankColumnDraft(engine, extraKey);
  const visible = rows.some((row) => row.originalName === null && !row.dropped && row.name.trim() === "") ? rows : [...rows, phantom];
  const dirty = rows.some((row) => columnDraftDirty(row, engine));
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  });
  useEffect(() => {
    onDraftChangeRef.current?.(dirty ? rows : null);
  }, [dirty, rows]);
  const dropped = rows.filter((row) => row.dropped && row.originalName);

  const patch = (key: string, change: Partial<ColumnDraft>) => {
    const absorbed = key === phantom.key && !rows.some((row) => row.key === key);
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      if (index >= 0) {
        const next = current.slice();
        next[index] = { ...next[index], ...change };
        return next;
      }
      if (key !== phantom.key) return current;
      return [...current, { ...phantom, ...change }];
    });
    if (absorbed) setExtraKey(crypto.randomUUID());
    setLocalError(null);
    setConfirmDrop(false);
  };

  const removeRow = (row: ColumnDraft) => {
    if (row.originalName) patch(row.key, { dropped: true });
    else setRows((current) => current.filter((item) => item.key !== row.key));
    setConfirmDrop(false);
  };

  const apply = useCallback(async () => {
    try {
      const statements = columnChangeSql(table, rows, engine);
      if (statements.length === 0) return;
      setLocalError(null);
      await onApply(statements);
      setConfirmDrop(false);
    } catch (caught) {
      setLocalError(errorMessage(caught));
    }
  }, [engine, onApply, rows, table]);

  const save = () => {
    if (!dirty || busy) return;
    if (dropped.length > 0 && !confirmDrop) {
      setConfirmDrop(true);
      return;
    }
    void apply();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey)) return;
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !focused.closest(".structure-editor")) return;
      if (!dirty || busy) return;
      event.preventDefault();
      event.stopPropagation();
      if (dropped.length > 0 && !confirmDrop) {
        setConfirmDrop(true);
        return;
      }
      void apply();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [apply, busy, confirmDrop, dirty, dropped.length]);
  const saveShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";

  return (
    <div className="structure-editor">
      <div className="structure-scroll">
        <table className="structure-table">
          <thead>
            <tr>
              <th className="col-index">#</th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th className="col-null">NULL</th>
              <th>Predeterminado</th>
              <th className="col-action" />
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
              const spec = specs.find((item) => item.name === row.dataType);
              const options = spec ? specs : [{ name: row.dataType, kind: "plain" as const }, ...specs];
              const locked = engine === "sqlite" && row.originalName !== null;
              const generated = Boolean(spec?.generated);
              const fresh = row.key === phantom.key;
              return (
                <tr key={row.key} className={row.dropped ? "dropped" : fresh ? "fresh" : undefined}>
                  <td className="col-index">{row.primaryKey ? "pk" : index + 1}</td>
                  <td>
                    <input
                      aria-label="Nombre de la columna"
                      value={row.name}
                      disabled={busy || row.dropped}
                      placeholder="nueva columna"
                      onChange={(event) => patch(row.key, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <div className="type-cell">
                      <select
                        aria-label="Tipo"
                        value={row.dataType}
                        disabled={busy || row.dropped || locked}
                        onChange={(event) => patch(row.key, { dataType: event.target.value, length: "", precision: "", scale: "" })}
                      >
                        {options.map((item) => (
                          <option key={item.name} value={item.name}>{item.name}</option>
                        ))}
                      </select>
                      {spec?.kind === "length" ? (
                        <input
                          aria-label="Longitud"
                          className="type-size"
                          value={row.length}
                          disabled={busy || row.dropped || locked}
                          placeholder="n"
                          inputMode="numeric"
                          onChange={(event) => patch(row.key, { length: event.target.value })}
                        />
                      ) : null}
                      {spec?.kind === "numeric" ? (
                        <>
                          <input
                            aria-label="Precisión"
                            className="type-size"
                            value={row.precision}
                            disabled={busy || row.dropped || locked}
                            placeholder="p"
                            inputMode="numeric"
                            onChange={(event) => patch(row.key, { precision: event.target.value })}
                          />
                          <input
                            aria-label="Escala"
                            className="type-size"
                            value={row.scale}
                            disabled={busy || row.dropped || locked}
                            placeholder="e"
                            inputMode="numeric"
                            onChange={(event) => patch(row.key, { scale: event.target.value })}
                          />
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <select
                      aria-label="Acepta NULL"
                      value={row.nullable ? "yes" : "no"}
                      disabled={busy || row.dropped || locked || generated || row.primaryKey}
                      onChange={(event) => patch(row.key, { nullable: event.target.value === "yes" })}
                    >
                      <option value="yes">Sí</option>
                      <option value="no">No</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label="Valor predeterminado"
                      value={row.defaultValue}
                      disabled={busy || row.dropped || locked || generated}
                      placeholder="—"
                      onChange={(event) => patch(row.key, { defaultValue: event.target.value })}
                    />
                  </td>
                  <td className="col-action">
                    {fresh ? null : (
                      <button
                        type="button"
                        className="tiny-icon"
                        aria-label={row.dropped ? `Restaurar ${row.name || "columna"}` : `Quitar ${row.name || "columna"}`}
                        disabled={busy}
                        onClick={() => (row.dropped ? patch(row.key, { dropped: false }) : removeRow(row))}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="structure-bar">
        <span>
          {confirmDrop
            ? `Se quitan ${dropped.map((row) => row.originalName).join(", ")} y sus datos.`
            : localError || error
              ? localError || error
              : engine === "sqlite"
                ? "En SQLite una columna existente solo se puede renombrar o quitar."
                : "La última fila agrega una columna."}
        </span>
        {dirty ? (
          <div className="structure-actions">
            {confirmDrop ? (
              <button type="button" className="toolbar-button" disabled={busy} onClick={() => setConfirmDrop(false)}>
                Volver
              </button>
            ) : null}
            <button type="button" className="run-button" disabled={busy} onClick={save}>
              {confirmDrop ? "Quitar y guardar" : "Guardar"}
              {confirmDrop ? null : <kbd>{saveShortcut}</kbd>}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

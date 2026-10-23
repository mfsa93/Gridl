import { ArrowUpRight, CircleAlert, Copy, ShieldAlert, ShieldX, TriangleAlert, Download, Filter, History, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatSqlValue, type BatchStatement, type ColumnDefinition, type SqlValue } from "../lib/api";
import { exportFormats, type ExportFormat } from "./export";
import { blankFilter, filterOps, opTakesValue, type FilterOp, type TableFilter } from "./filters";
import type { ShownError } from "../lib/errors";
import type { GuardInfo } from "../lib/api";
import { environmentLabel } from "../lib/environments";
import type { HistoryEntry } from "./history";

/** Closes a popover when the pointer goes down outside it or Escape is pressed. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

export function FilterBar({
  columns,
  filters,
  busy,
  onChange,
  onApply,
}: {
  columns: ColumnDefinition[];
  filters: TableFilter[];
  busy: boolean;
  onChange: (filters: TableFilter[]) => void;
  onApply: (filters: TableFilter[]) => void;
}) {
  const patch = (id: string, change: Partial<TableFilter>) =>
    onChange(filters.map((filter) => (filter.id === id ? { ...filter, ...change } : filter)));
  const first = columns[0]?.name ?? "";
  return (
    <div className="filter-bar">
      {filters.map((filter) => (
        <div key={filter.id} className="filter-row">
          <input
            type="checkbox"
            aria-label="Usar filtro"
            checked={filter.enabled}
            onChange={(event) => {
              const next = filters.map((item) => (item.id === filter.id ? { ...item, enabled: event.target.checked } : item));
              onChange(next);
              onApply(next);
            }}
          />
          {filter.op === "sql" ? null : (
            <select value={filter.column} aria-label="Columna" onChange={(event) => patch(filter.id, { column: event.target.value })}>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>{column.name}</option>
              ))}
            </select>
          )}
          <select value={filter.op} aria-label="Operador" onChange={(event) => patch(filter.id, { op: event.target.value as FilterOp })}>
            {filterOps.map((item) => (
              <option key={item.op} value={item.op}>{item.label}</option>
            ))}
          </select>
          {opTakesValue(filter.op) ? (
            <input
              className="filter-value"
              value={filter.value}
              placeholder={filter.op === "sql" ? "precio > 10 and activo" : filter.op === "in" ? "a, b, c" : "valor"}
              onChange={(event) => patch(filter.id, { value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onApply(filters);
                }
              }}
            />
          ) : (
            <span className="filter-value" />
          )}
          <button
            type="button"
            className="tiny-icon"
            aria-label="Quitar filtro"
            onClick={() => {
              const next = filters.filter((item) => item.id !== filter.id);
              onChange(next);
              onApply(next);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="filter-actions">
        <button type="button" className="toolbar-button" onClick={() => onChange([...filters, blankFilter(first)])}>
          <Plus size={13} /> Condición
        </button>
        <button type="button" className="run-button" disabled={busy} onClick={() => onApply(filters)}>
          Filtrar
        </button>
        {filters.length > 0 ? (
          <button
            type="button"
            className="toolbar-button"
            disabled={busy}
            onClick={() => {
              onChange([]);
              onApply([]);
            }}
          >
            Limpiar
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function FilterToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={open ? "toolbar-button active" : "toolbar-button"} onClick={onToggle}>
      <Filter size={14} /> Filtros{count > 0 ? ` (${count})` : ""}
    </button>
  );
}

export function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="toolbar-button" disabled={disabled} onClick={() => setOpen((current) => !current)}>
        <Download size={14} /> Exportar
      </button>
      {open ? (
        <div className="popover-menu">
          {exportFormats.map((item) => (
            <button
              key={item.format}
              type="button"
              onClick={() => {
                setOpen(false);
                onExport(item.format);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "ahora";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Date(at).toLocaleDateString("es");
}

export function HistoryMenu({
  entries,
  onPick,
  onStar,
  onRemove,
  onClear,
}: {
  entries: HistoryEntry[];
  onPick: (sql: string) => void;
  onStar: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const [onlyStarred, setOnlyStarred] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const shown = useMemo(() => {
    const query = needle.trim().toLowerCase();
    return entries.filter((entry) => (!onlyStarred || entry.starred) && (!query || entry.sql.toLowerCase().includes(query)));
  }, [entries, needle, onlyStarred]);
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="toolbar-button" onClick={() => setOpen((current) => !current)}>
        <History size={14} /> Historial
      </button>
      {open ? (
        <div className="popover-menu history-menu">
          <div className="history-tools">
            <input value={needle} autoFocus placeholder="Buscar en el historial" onChange={(event) => setNeedle(event.target.value)} />
            <button type="button" className={onlyStarred ? "tiny-icon active" : "tiny-icon"} aria-label="Solo favoritas" title="Solo favoritas" onClick={() => setOnlyStarred((current) => !current)}>
              <Star size={13} />
            </button>
            <button type="button" className="tiny-icon" aria-label="Vaciar historial" title="Vaciar (conserva favoritas)" onClick={onClear}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="history-list">
            {shown.length === 0 ? <div className="history-empty">Sin consultas.</div> : null}
            {shown.map((entry) => (
              <div key={entry.id} className={entry.ok ? "history-item" : "history-item failed"}>
                <button
                  type="button"
                  className="history-sql"
                  title={entry.sql}
                  onClick={() => {
                    setOpen(false);
                    onPick(entry.sql);
                  }}
                >
                  <code>{entry.sql.length > 220 ? `${entry.sql.slice(0, 220)}…` : entry.sql}</code>
                  <span>
                    {relativeTime(entry.at)}
                    {entry.durationMs !== null ? ` · ${entry.durationMs} ms` : ""}
                    {entry.ok ? "" : " · error"}
                  </span>
                </button>
                <button type="button" className={entry.starred ? "tiny-icon starred" : "tiny-icon"} aria-label="Favorita" onClick={() => onStar(entry.id)}>
                  <Star size={13} />
                </button>
                <button type="button" className="tiny-icon" aria-label="Quitar" onClick={() => onRemove(entry.id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function inlineSql(statement: BatchStatement): string {
  if (statement.params.length === 0) return statement.sql;
  const values = statement.params.map((value) => (value.t === "null" ? "NULL" : formatSqlValue(value)));
  return `${statement.sql}\n  -- parámetros: ${values.join(", ")}`;
}

export function PreviewDialog({
  statements,
  busy,
  error,
  onClose,
  onApply,
}: {
  statements: BatchStatement[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApply: () => void;
}) {
  const text = statements.map((statement) => `${inlineSql(statement)};`).join("\n\n");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal preview-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-topline">
          <h2>Cambios pendientes</h2>
          <button type="button" className="close-button" aria-label="Cerrar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">
          {statements.length === 1 ? "1 sentencia" : `${statements.length} sentencias`} en una sola transacción. Si alguna falla, no se aplica ninguna.
        </p>
        <pre className="preview-sql">{text}</pre>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy size={14} /> Copiar
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>Cerrar</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onApply}>Aplicar</button>
        </div>
      </div>
    </div>
  );
}

function prettyValue(value: SqlValue | undefined): { text: string; isNull: boolean; json: boolean } {
  if (!value || value.t === "null") return { text: "NULL", isNull: true, json: false };
  const text = formatSqlValue(value);
  if (value.t === "text" && /^\s*[[{]/.test(text)) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), isNull: false, json: true };
    } catch {
      return { text, isNull: false, json: false };
    }
  }
  return { text, isNull: false, json: false };
}

export function RowDetails({
  columns,
  row,
  index,
  relation,
}: {
  columns: ColumnDefinition[];
  row: SqlValue[];
  index: number;
  /** A link to the referenced row when the column is a foreign key. */
  relation?: (column: string) => { label: string; open: () => void } | null;
}) {
  return (
    <div className="details-body row-details">
      <strong>Fila {index + 1}</strong>
      <dl className="row-fields-list">
        {columns.map((column, position) => {
          const shown = prettyValue(row[position]);
          const link = shown.isNull ? null : (relation?.(column.name) ?? null);
          return (
            <div key={`${position}:${column.name}`} className="row-field">
              <dt>
                <span>{column.name}</span>
                <button type="button" className="tiny-icon" aria-label={`Copiar ${column.name}`} onClick={() => void navigator.clipboard?.writeText(shown.isNull ? "" : shown.text)}>
                  <Copy size={12} />
                </button>
              </dt>
              <dd className={shown.isNull ? "null" : shown.json ? "json" : undefined}>{shown.text}</dd>
              {link ? (
                <button type="button" className="relation-link row-jump" onClick={link.open}>
                  Abrir en {link.label} <ArrowUpRight size={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** Readable error with the database message, a hint when one applies, and a copy button. */
export function ErrorPanel({
  error,
  compact = false,
  onClose,
  action,
}: {
  error: ShownError;
  compact?: boolean;
  onClose?: () => void;
  /** A button that can fix the error, such as reconnecting. */
  action?: { label: string; run: () => void; busy?: boolean } | null;
}) {
  return (
    <div className={compact ? "error-panel compact" : "error-panel"} role="alert">
      <CircleAlert size={compact ? 15 : 18} className="error-icon" />
      <div className="error-text">
        <strong>{compact ? error.message : "La consulta falló"}</strong>
        {compact ? null : <pre>{error.message}</pre>}
        {error.hint ? <p className="error-hint">{error.hint}</p> : null}
      </div>
      <div className="error-actions">
        {action ? (
          <button type="button" className="toolbar-button error-action" disabled={action.busy} onClick={action.run}>{action.busy ? "Reconectando…" : action.label}</button>
        ) : null}
        <button type="button" className="tiny-icon" aria-label="Copiar error" title="Copiar error" onClick={() => void navigator.clipboard?.writeText(error.message)}>
          <Copy size={13} />
        </button>
        {onClose ? (
          <button type="button" className="tiny-icon" aria-label="Cerrar" onClick={onClose}>
            <X size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ResultMessage({ text }: { text: string }) {
  return <div className="result-message">{text}</div>;
}

export type MenuItem =
  | { label: string; run: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | "separator";

/** A macOS-style context menu at a pointer position, kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  const [position, setPosition] = useState({ x, y });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [ref, x, y]);
  return (
    <div ref={ref} className="tree-menu context-menu" role="menu" style={{ left: position.x, top: position.y }} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={`sep-${index}`} className="temporal-sep" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <kbd>{item.hint}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * Asks before running SQL the connection's policy guards. Production and
 * destructive statements need the database name typed, so a stray Enter
 * cannot authorize them.
 */
export function GuardDialog({
  info,
  database,
  many,
  onCancel,
  onConfirm,
}: {
  info: GuardInfo;
  database: string;
  many: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const environment = environmentLabel(info.environment);
  const blocked = info.mode === "block";
  const expected = database.split(/[\\/]/).pop() || database;
  const mustType = !blocked && (info.dangerous || info.environment === "production");
  const ready = !mustType || typed.trim() === expected;
  const sql = info.sql.length > 4000 ? `${info.sql.slice(0, 4000)}\n…` : info.sql;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className={`modal guard-modal env-${info.environment}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked && ready) onConfirm();
        }}
      >
        <div className="guard-head">
          <span className="guard-icon">{blocked ? <ShieldX size={22} /> : <ShieldAlert size={22} />}</span>
          <div>
            <span className={`env-pill env-${info.environment}`}>{environment}</span>
            <h2>{blocked ? "Sentencia bloqueada" : info.dangerous ? "Operación destructiva" : "¿Autorizas este cambio?"}</h2>
          </div>
        </div>
        <p className="modal-description">
          {blocked
            ? `La política de ${environment} no permite sentencias que ${info.reason}. Puedes cambiarla en Editar conexión → Seguridad.`
            : info.dangerous
              ? `${info.reason}. Revisa la sentencia antes de seguir.`
              : `Esta sentencia ${info.reason} en una conexión de ${environment}.`}
        </p>
        <pre className="preview-sql guard-sql">{sql}</pre>
        {mustType ? (
          <label className="form-field guard-type">
            <span>Escribe <code>{expected}</code> para confirmar</span>
            <input value={typed} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setTyped(event.target.value)} />
          </label>
        ) : null}
        {many && !blocked ? <p className="field-hint">La autorización vale para el resto de sentencias de este script.</p> : null}
        <div className="modal-footer">
          {blocked ? (
            <button type="button" className="primary-button" autoFocus onClick={onCancel}>Entendido</button>
          ) : (
            <>
              <button type="button" className="secondary-button" autoFocus={!mustType} onClick={onCancel}>Cancelar</button>
              <button type="submit" className={info.dangerous || info.environment === "production" ? "primary-button danger-button" : "primary-button"} disabled={!ready}>
                Ejecutar
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** Warns before leaving with edits that would be lost. Keeping them is the default. */
export function UnsavedDialog({
  items,
  action,
  onCancel,
  onDiscard,
}: {
  items: string[];
  action: string;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal unsaved-modal"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <div className="guard-head">
          <span className="guard-icon unsaved-icon"><TriangleAlert size={22} /></span>
          <div>
            <h2>Hay cambios sin guardar</h2>
          </div>
        </div>
        <p className="modal-description">Si continúas, se pierden:</p>
        <ul className="unsaved-list">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <div className="modal-footer">
          <button type="button" className="secondary-button" autoFocus onClick={onCancel}>Seguir editando</button>
          <button type="button" className="primary-button danger-button" onClick={onDiscard}>{action} y descartar</button>
        </div>
      </div>
    </div>
  );
}

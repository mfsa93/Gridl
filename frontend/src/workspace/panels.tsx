import { ArrowUpRight, Check, CircleAlert, Copy, Search, ShieldAlert, SquareTerminal, ShieldX, TriangleAlert, Download, Filter, History, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatSqlValue, type BatchStatement, type ColumnDefinition, type SqlValue, type TableSchema } from "../lib/api";
import { exportFormats, type ExportFormat } from "./export";
import { blankFilter, filterOps, opTakesValue, type FilterOp, type TableFilter } from "./filters";
import type { ShownError } from "../lib/errors";
import type { GuardInfo } from "../lib/api";
import { environmentLabel } from "../lib/environments";
import type { HistoryEntry } from "./history";
import { formatDate, plural, t } from "../lib/i18n";
import { useDismiss } from "./useDismiss";

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
            aria-label={t("panel.filter.use")}
            checked={filter.enabled}
            onChange={(event) => {
              const next = filters.map((item) => (item.id === filter.id ? { ...item, enabled: event.target.checked } : item));
              onChange(next);
              onApply(next);
            }}
          />
          {filter.op === "sql" ? null : (
            <select value={filter.column} aria-label={t("panel.filter.column")} onChange={(event) => patch(filter.id, { column: event.target.value })}>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>{column.name}</option>
              ))}
            </select>
          )}
          <select value={filter.op} aria-label={t("panel.filter.operator")} onChange={(event) => patch(filter.id, { op: event.target.value as FilterOp })}>
            {filterOps.map((item) => (
              <option key={item.op} value={item.op}>{item.label}</option>
            ))}
          </select>
          {opTakesValue(filter.op) ? (
            <input
              className="filter-value"
              value={filter.value}
              placeholder={filter.op === "sql" ? t("panel.filter.sqlPlaceholder") : filter.op === "in" ? "a, b, c" : t("panel.filter.valuePlaceholder")}
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
            aria-label={t("panel.filter.remove")}
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
          <Plus size={13} /> {t("panel.filter.condition")}
        </button>
        <button type="button" className="run-button" disabled={busy} onClick={() => onApply(filters)}>
          {t("panel.filter.apply")}
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
            {t("panel.filter.clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function FilterToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={open ? "toolbar-button active" : "toolbar-button"} title={t("panel.filter.toggle")} onClick={onToggle}>
      <Filter size={14} /> {t("panel.filter.toggle")}{count > 0 ? ` (${count})` : ""}
    </button>
  );
}

export function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="toolbar-button" disabled={disabled} title={t("panel.export")} onClick={() => setOpen((current) => !current)}>
        <Download size={14} /> {t("panel.export")}
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
  if (seconds < 60) return t("panel.history.now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("panel.history.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("panel.history.hoursAgo", { count: hours });
  return formatDate(at);
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
        <History size={14} /> {t("panel.history.title")}
      </button>
      {open ? (
        <div className="popover-menu history-menu">
          <div className="history-tools">
            <input value={needle} autoFocus placeholder={t("panel.history.search")} onChange={(event) => setNeedle(event.target.value)} />
            <button type="button" className={onlyStarred ? "tiny-icon active" : "tiny-icon"} aria-label={t("panel.history.onlyStarred")} title={t("panel.history.onlyStarred")} onClick={() => setOnlyStarred((current) => !current)}>
              <Star size={13} />
            </button>
            <button type="button" className="tiny-icon" aria-label={t("panel.history.clear")} title={t("panel.history.clearTitle")} onClick={onClear}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="history-list">
            {shown.length === 0 ? <div className="history-empty">{t("panel.history.empty")}</div> : null}
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
                    {entry.ok ? "" : ` · ${t("panel.history.failed")}`}
                  </span>
                </button>
                <button type="button" className={entry.starred ? "tiny-icon starred" : "tiny-icon"} aria-label={t("panel.history.star")} onClick={() => onStar(entry.id)}>
                  <Star size={13} />
                </button>
                <button type="button" className="tiny-icon" aria-label={t("panel.history.remove")} onClick={() => onRemove(entry.id)}>
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
  return `${statement.sql}\n  -- ${t("panel.preview.params")}: ${values.join(", ")}`;
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
          <h2>{t("panel.preview.title")}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">
          {plural("panel.preview.description", statements.length)}
        </p>
        <pre className="preview-sql">{text}</pre>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy size={14} /> {t("panel.preview.copy")}
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.close")}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onApply}>{t("panel.preview.apply")}</button>
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
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const fields = columns.map((column, position) => ({ column, position })).filter(({ column }) => !needle || column.name.toLowerCase().includes(needle));
  return (
    <>
      <div className="row-details-head">
        <strong>{t("panel.row.title", { number: index + 1 })}</strong>
        {columns.length > 8 ? (
          <div className="explorer-search row-search">
            <Search size={13} />
            <input value={query} placeholder={t("panel.row.search")} aria-label={t("panel.row.search")} onChange={(event) => setQuery(event.target.value)} />
          </div>
        ) : null}
      </div>
      <div className="details-body row-details">
        {fields.length === 0 ? <span className="relation-empty plain">{t("panel.row.noMatch")}</span> : null}
        <dl className="row-fields-list" hidden={fields.length === 0}>
          {fields.map(({ column, position }) => {
            const shown = prettyValue(row[position]);
            const link = shown.isNull ? null : (relation?.(column.name) ?? null);
            return (
              <div key={`${position}:${column.name}`} className="row-field">
                <dt>
                  <span className="row-field-name">
                    {column.name}
                    {column.dataType ? <small>{column.dataType}</small> : null}
                  </span>
                  <button type="button" className="tiny-icon" aria-label={t("panel.row.copy", { column: column.name })} onClick={() => void navigator.clipboard?.writeText(shown.isNull ? "" : shown.text)}>
                    <Copy size={12} />
                  </button>
                </dt>
                <dd className={shown.isNull ? "null" : shown.json ? "json" : undefined}>{shown.text}</dd>
                {link ? (
                  <button type="button" className="relation-link row-jump" onClick={link.open}>
                    {t("panel.row.openIn", { table: link.label })} <ArrowUpRight size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </dl>
      </div>
    </>
  );
}

/** Toolbar button that copies `text` and says so for a moment. */
export function CopyButton({ text, label, title }: { text: string; label: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="toolbar-button"
      title={title}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("panel.copied") : label}
    </button>
  );
}

/** Result type and parameters of a function or procedure, shown above its definition. */
export function RoutineSummary({ routine, onUse }: { routine: TableSchema; onUse: () => void }) {
  const columns = routine.columns;
  const defaults = columns.some((column) => column.defaultValue !== null);
  return (
    <section className="routine-args">
      <div className="routine-head">
        <div className="relations-title">
          {t("panel.arguments.title")} <small>{columns.length}</small>
        </div>
        <button type="button" className="toolbar-button" title={t("panel.arguments.useTitle")} onClick={onUse}>
          <SquareTerminal size={14} /> {t("panel.arguments.use")}
        </button>
      </div>
      {routine.returns ? (
        <div className="routine-returns">
          {t("panel.arguments.returns")} <span className="mono" title={routine.returns}>{routine.returns}</span>
        </div>
      ) : null}
      {columns.length === 0 ? (
        <div className="relation-empty plain">{t("panel.arguments.none")}</div>
      ) : (
        <div className={defaults ? "relation-group routine-table with-defaults" : "relation-group routine-table"}>
          <div className="routine-arg relation-head">
            <span>{t("panel.arguments.name")}</span>
            <span>{t("panel.arguments.type")}</span>
            {defaults ? <span>{t("panel.arguments.default")}</span> : null}
          </div>
          {columns.map((column, position) => (
            <div key={`${position}:${column.name}`} className="routine-arg">
              <span className="routine-name">
                <span className="mono" title={column.name}>{column.name}</span>
                {column.mode && column.mode !== "IN" ? <span className="routine-mode" title={t("panel.arguments.modeTitle")}>{column.mode}</span> : null}
              </span>
              <span className="mono" title={column.dataType}>{column.dataType}</span>
              {defaults ? <span className="mono" title={column.defaultValue ?? undefined}>{column.defaultValue ?? ""}</span> : null}
            </div>
          ))}
        </div>
      )}
    </section>
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
        <strong>{compact ? error.message : t("panel.error.queryFailed")}</strong>
        {compact ? null : <pre>{error.message}</pre>}
        {error.hint ? <p className="error-hint">{error.hint}</p> : null}
      </div>
      <div className="error-actions">
        {action ? (
          <button type="button" className="toolbar-button error-action" disabled={action.busy} onClick={action.run}>{action.busy ? t("panel.error.reconnecting") : action.label}</button>
        ) : null}
        <button type="button" className="tiny-icon" aria-label={t("panel.error.copy")} title={t("panel.error.copy")} onClick={() => void navigator.clipboard?.writeText(error.message)}>
          <Copy size={13} />
        </button>
        {onClose ? (
          <button type="button" className="tiny-icon" aria-label={t("dialog.close")} onClick={onClose}>
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
            <h2>{blocked ? t("guard.title.blocked") : info.dangerous ? t("guard.title.dangerous") : t("guard.title.confirm")}</h2>
          </div>
        </div>
        <p className="modal-description">
          {blocked
            ? t("guard.description.blocked", { environment, reason: info.reason })
            : info.dangerous
              ? t("guard.description.dangerous", { reason: info.reason })
              : t("guard.description.confirm", { environment, reason: info.reason })}
        </p>
        <pre className="preview-sql guard-sql">{sql}</pre>
        {mustType ? (
          <label className="form-field guard-type">
            <span>{t("guard.typeBefore")}<code>{expected}</code>{t("guard.typeAfter")}</span>
            <input value={typed} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setTyped(event.target.value)} />
          </label>
        ) : null}
        {many && !blocked ? <p className="field-hint">{t("guard.many")}</p> : null}
        <div className="modal-footer">
          {blocked ? (
            <button type="button" className="primary-button" autoFocus onClick={onCancel}>{t("guard.ok")}</button>
          ) : (
            <>
              <button type="button" className="secondary-button" autoFocus={!mustType} onClick={onCancel}>{t("dialog.cancel")}</button>
              <button type="submit" className={info.dangerous || info.environment === "production" ? "primary-button danger-button" : "primary-button"} disabled={!ready}>
                {t("guard.run")}
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
            <h2>{t("dialog.unsaved.title")}</h2>
          </div>
        </div>
        <p className="modal-description">{t("dialog.unsaved.description")}</p>
        <ul className="unsaved-list">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <div className="modal-footer">
          <button type="button" className="secondary-button" autoFocus onClick={onCancel}>{t("dialog.unsaved.keepEditing")}</button>
          <button type="button" className="primary-button danger-button" onClick={onDiscard}>{t("dialog.unsaved.discard", { action })}</button>
        </div>
      </div>
    </div>
  );
}

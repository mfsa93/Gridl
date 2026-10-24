import { GitCompareArrows, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DatabaseEngine, SqlValue, TableSchema } from "../lib/api";
import { errorMessage } from "../lib/api";
import { formatNumber, t } from "../lib/i18n";
import { LogoLoader } from "./LogoLoader";
import { compareRowLimit, compareSql, parseCounts, parseDiff, type DiffKind, type DiffRow } from "./compare";

const label = (table: TableSchema) => (table.schema ? `${table.schema}.${table.name}` : table.name);

/** Compares the open table (A) with another table of the connection (B), row by row. */
export function CompareView({
  engine,
  table,
  tables,
  query,
  onClose,
}: {
  engine: DatabaseEngine;
  table: TableSchema;
  tables: TableSchema[];
  /** Runs a read and returns its rows. */
  query: (sql: string) => Promise<SqlValue[][]>;
  onClose: () => void;
}) {
  const others = useMemo(() => tables.filter((item) => item.kind === "table" && label(item) !== label(table)), [table, tables]);
  // A table of the same name in another schema is the usual partner (public vs staging).
  const [other, setOther] = useState(() => label(others.find((item) => item.name === table.name) ?? others[0] ?? table));
  const [state, setState] = useState<{ status: "idle" | "running" | "done" | "failed"; rows: DiffRow[]; counts: Record<DiffKind, number> | null; message: string | null }>({ status: "idle", rows: [], counts: null, message: null });
  const [shown, setShown] = useState<Record<DiffKind, boolean>>({ changed: true, removed: true, added: true });
  const target = others.find((item) => label(item) === other) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async () => {
    if (!target) return;
    setState({ status: "running", rows: [], counts: null, message: null });
    const attempt = async (asText: boolean) => {
      const plan = compareSql(engine, table, target, asText);
      if ("error" in plan) throw new Error(plan.error === "no-key" ? t("app.compare.noKey") : plan.error === "key-missing" ? t("app.compare.keyMissing", { column: plan.missing ?? "" }) : t("app.compare.noColumns"));
      const [rows, counts] = await Promise.all([query(plan.sql), query(plan.countSql)]);
      return { rows: parseDiff(rows, plan.keys, plan.columns), counts: parseCounts(counts) };
    };
    try {
      let result;
      try {
        result = await attempt(false);
      } catch (caught) {
        // Columns of types the database cannot compare (text with integer…) compare as text.
        if (/operator does not exist|cannot compare|incompatible|Illegal mix/i.test(errorMessage(caught))) result = await attempt(true);
        else throw caught;
      }
      setState({ status: "done", rows: result.rows, counts: result.counts, message: null });
    } catch (caught) {
      setState({ status: "failed", rows: [], counts: null, message: errorMessage(caught) });
    }
  };

  const total = state.counts ? state.counts.changed + state.counts.removed + state.counts.added : 0;
  const visible = state.rows.filter((row) => shown[row.kind]);
  return (
    <div className="diagram-overlay compare-overlay" role="dialog" aria-label={t("app.compare.title")}>
      <div className="diagram-toolbar">
        <strong>{t("app.compare.title")}</strong>
        <span className="compare-side"><b>A</b> {label(table)}</span>
        <span className="compare-side">
          <b>B</b>
          <select value={other} onChange={(event) => setOther(event.target.value)} aria-label={t("app.compare.pick")}>
            {others.map((item) => <option key={label(item)} value={label(item)}>{label(item)}</option>)}
          </select>
        </span>
        <button type="button" className="primary-button compare-run" disabled={!target || state.status === "running"} onClick={() => void run()}>
          <GitCompareArrows size={14} /> {t("app.compare.run")}
        </button>
        <div className="diagram-actions">
          <button type="button" className="icon-button" aria-label={t("dialog.close")} title={t("dialog.close")} onClick={onClose}><X size={16} /></button>
        </div>
      </div>
      <div className="compare-body">
        {state.status === "idle" ? <div className="diagram-empty">{t("app.compare.hint")}</div> : null}
        {state.status === "running" ? <div className="diagram-empty"><LogoLoader label={t("app.compare.running")} /></div> : null}
        {state.status === "failed" ? <div className="diagram-empty compare-error">{state.message}</div> : null}
        {state.status === "done" && state.counts ? (
          <>
            <div className="compare-summary">
              {total === 0 ? <span className="compare-same">{t("app.compare.same")}</span> : null}
              {(["changed", "removed", "added"] as const).map((kind) => (
                <button key={kind} type="button" className={shown[kind] ? `compare-chip ${kind} on` : `compare-chip ${kind}`} aria-pressed={shown[kind]} onClick={() => setShown((current) => ({ ...current, [kind]: !current[kind] }))}>
                  {t(`app.compare.${kind}`)} <b>{formatNumber(state.counts?.[kind] ?? 0)}</b>
                </button>
              ))}
              {total > compareRowLimit ? <span className="diagram-note">{t("app.compare.limited", { count: formatNumber(compareRowLimit) })}</span> : null}
            </div>
            <div className="compare-list">
              {visible.map((row, index) => (
                <div key={`${row.kind}:${row.key.join(",")}:${index}`} className={`compare-row ${row.kind}`}>
                  <span className={`compare-kind ${row.kind}`}>{t(`app.compare.short.${row.kind}`)}</span>
                  <span className="compare-key">{row.key.join(", ")}</span>
                  <span className="compare-detail">
                    {row.kind === "changed"
                      ? row.changes.map(([column, left, right]) => (
                          <span key={column} className="compare-change">
                            <i>{column}</i> <del>{left ?? "NULL"}</del> → <ins>{right ?? "NULL"}</ins>
                          </span>
                        ))
                      : row.values.map(([column, value]) => (
                          <span key={column} className="compare-value"><i>{column}</i> {value ?? "NULL"}</span>
                        ))}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

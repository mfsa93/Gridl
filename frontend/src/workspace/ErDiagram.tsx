import { KeyRound, Link2, Maximize, Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ForeignKey, TableSchema } from "../lib/api";
import { formatNumber, t } from "../lib/i18n";
import { boxWidth, diagramEdges, headerHeight, layoutDiagram, rowHeight, tableKey, type Placed } from "./diagramLayout";

/** Above this many tables the diagram is too dense to read; it asks to narrow the schema. */
const diagramLimit = 150;

type View = { x: number; y: number; scale: number };

/**
 * The tables of a schema as boxes with their keys drawn between them. Boxes
 * drag, the canvas pans and zooms, and a table name opens the table.
 */
export function ErDiagram({ title, tables, keys, onOpen, onClose }: { title: string; tables: TableSchema[]; keys: ForeignKey[]; onOpen: (table: TableSchema) => void; onClose: () => void }) {
  const shown = useMemo(() => tables.filter((table) => table.kind === "table").slice(0, diagramLimit), [tables]);
  const tooMany = tables.filter((table) => table.kind === "table").length > diagramLimit;
  const edges = useMemo(() => diagramEdges(shown, keys), [keys, shown]);
  const initial = useMemo(() => layoutDiagram(shown, edges), [edges, shown]);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const boxes: Placed[] = initial.map((box) => ({ ...box, ...moved[box.key] }));
  const byKey = new Map(boxes.map((box) => [box.key, box]));
  const [view, setView] = useState<View>({ x: 40, y: 40, scale: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "pan" | "box"; key?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const fit = () => {
    const element = stage.current;
    if (!element || boxes.length === 0) return;
    const right = Math.max(...boxes.map((box) => box.x + boxWidth));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    const scale = Math.min(1, Math.max(0.2, Math.min((element.clientWidth - 80) / right, (element.clientHeight - 80) / bottom)));
    setView({ x: 40, y: 40, scale });
  };
  // Fit once the boxes are known; the stage has its size by then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [initial]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const zoom = (factor: number, centerX?: number, centerY?: number) => {
    setView((current) => {
      const scale = Math.min(2, Math.max(0.15, current.scale * factor));
      const rect = stage.current?.getBoundingClientRect();
      const cx = centerX ?? (rect ? rect.width / 2 : 0);
      const cy = centerY ?? (rect ? rect.height / 2 : 0);
      // Keep the point under the pointer still while zooming.
      return { scale, x: cx - ((cx - current.x) * scale) / current.scale, y: cy - ((cy - current.y) * scale) / current.scale };
    });
  };

  const onPointerDown = (event: ReactPointerEvent, key?: string) => {
    if (event.button !== 0) return;
    const box = key ? byKey.get(key) : undefined;
    drag.current = key && box
      ? { kind: "box", key, startX: event.clientX, startY: event.clientY, originX: box.x, originY: box.y }
      : { kind: "pan", startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.stopPropagation();
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (active.kind === "pan") setView((current) => ({ ...current, x: active.originX + dx, y: active.originY + dy }));
    else if (active.key) {
      const key = active.key;
      setMoved((current) => ({ ...current, [key]: { x: active.originX + dx / view.scale, y: active.originY + dy / view.scale } }));
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const anchor = (box: Placed, column: string) => {
    const index = Math.max(0, box.table.columns.findIndex((item) => item.name === column));
    return box.y + headerHeight + index * rowHeight + rowHeight / 2;
  };
  const fkColumns = new Set(edges.map((edge) => `${edge.from}:${edge.fromColumn}`));

  return (
    <div className="diagram-overlay" role="dialog" aria-label={t("app.diagram.title")}>
      <div className="diagram-toolbar">
        <strong>{t("app.diagram.title")}</strong>
        <span>{title} · {formatNumber(shown.length)} {t("app.diagram.tables")} · {formatNumber(edges.length)} {t("app.diagram.relations")}</span>
        {tooMany ? <span className="diagram-note">{t("app.diagram.limited", { count: diagramLimit })}</span> : null}
        <div className="diagram-actions">
          <button type="button" className="icon-button" aria-label={t("app.diagram.zoomOut")} title={t("app.diagram.zoomOut")} onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button>
          <span className="diagram-zoom">{Math.round(view.scale * 100)}%</span>
          <button type="button" className="icon-button" aria-label={t("app.diagram.zoomIn")} title={t("app.diagram.zoomIn")} onClick={() => zoom(1.2)}><Plus size={15} /></button>
          <button type="button" className="icon-button" aria-label={t("app.diagram.fit")} title={t("app.diagram.fit")} onClick={fit}><Maximize size={15} /></button>
          <button type="button" className="icon-button" aria-label={t("dialog.close")} title={t("dialog.close")} onClick={onClose}><X size={16} /></button>
        </div>
      </div>
      <div
        ref={stage}
        className="diagram-stage"
        onPointerDown={(event) => onPointerDown(event)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(event) => {
          const rect = stage.current?.getBoundingClientRect();
          if (event.ctrlKey || event.metaKey) zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, rect ? event.clientX - rect.left : undefined, rect ? event.clientY - rect.top : undefined);
          else setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
        }}
      >
        {shown.length === 0 ? <div className="diagram-empty">{t("app.diagram.empty")}</div> : null}
        <div className="diagram-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="diagram-edges" width="1" height="1">
            {edges.map((edge, index) => {
              const from = byKey.get(edge.from);
              const to = byKey.get(edge.to);
              if (!from || !to) return null;
              const y1 = anchor(from, edge.fromColumn);
              const y2 = anchor(to, edge.toColumn);
              const forward = to.x + boxWidth / 2 >= from.x + boxWidth / 2;
              const x1 = forward ? from.x + boxWidth : from.x;
              const x2 = forward ? to.x : to.x + boxWidth;
              const bend = Math.max(40, Math.abs(x2 - x1) / 2);
              const lit = hover !== null && (hover === edge.from || hover === edge.to);
              const path = from === to
                ? `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x1 + 60} ${y2}, ${x1} ${y2}`
                : `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 - (forward ? bend : -bend)} ${y2}, ${x2} ${y2}`;
              return (
                <g key={`${edge.name}:${index}`} className={lit ? "diagram-edge lit" : hover ? "diagram-edge dim" : "diagram-edge"}>
                  <path d={path}><title>{`${edge.name}: ${edge.fromColumn} → ${to.table.name}.${edge.toColumn}`}</title></path>
                  <circle cx={x2} cy={y2} r={3.5} />
                </g>
              );
            })}
          </svg>
          {boxes.map((box) => (
            <div
              key={box.key}
              className={hover === box.key ? "diagram-box lit" : "diagram-box"}
              style={{ left: box.x, top: box.y, width: boxWidth }}
              onPointerEnter={() => setHover(box.key)}
              onPointerLeave={() => setHover((current) => (current === box.key ? null : current))}
            >
              <div className="diagram-head" onPointerDown={(event) => onPointerDown(event, box.key)}>
                <button
                  type="button"
                  title={t("app.diagram.open", { name: box.table.name })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onOpen(box.table)}
                >
                  {box.table.name}
                </button>
              </div>
              {box.table.columns.map((column) => {
                const linked = fkColumns.has(`${tableKey(box.table.schema, box.table.name)}:${column.name}`);
                return (
                  <div key={column.name} className="diagram-column">
                    <span className="diagram-mark">
                      {column.primaryKey ? <KeyRound size={11} /> : linked ? <Link2 size={11} /> : null}
                    </span>
                    <span className={column.primaryKey ? "diagram-name pk" : "diagram-name"}>{column.name}</span>
                    <small>{column.dataType}</small>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { Braces, ChevronDown, ChevronLeft, ChevronRight, Hash, ListTree, Table2, Zap } from "lucide-react";
import { type ReactNode } from "react";
import { type TableSchema } from "../lib/api";
import { pageSizes, type TablePage } from "./model";

export function PaneSplitter({ label, axis = "x", onDrag }: { label: string; axis?: "x" | "y"; onDrag: (delta: number) => void }) {
  const vertical = axis === "y";
  return (
    <div
      className={vertical ? "pane-splitter row" : "pane-splitter"}
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("dragging");
        let last = vertical ? event.clientY : event.clientX;
        const move = (next: PointerEvent) => {
          const point = vertical ? next.clientY : next.clientX;
          onDrag(point - last);
          last = point;
        };
        const stop = () => {
          handle.classList.remove("dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      }}
    />
  );
}

export function TablePager({
  page,
  running,
  onPage,
  onPageSize,
  onCancel,
}: {
  page: TablePage | undefined;
  running: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
  onCancel: () => void;
}) {
  const current = page?.page ?? 0;
  const pageSize = page?.pageSize ?? 100;
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min(total, (current + 1) * pageSize);
  return (
    <div className="pager">
      <button type="button" disabled={running || current <= 0} onClick={() => onPage(current - 1)}>
        <ChevronLeft size={14} /> Anterior
      </button>
      <button type="button" disabled={running || current + 1 >= pageCount} onClick={() => onPage(current + 1)}>
        Siguiente <ChevronRight size={14} />
      </button>
      <span>{page ? `${from.toLocaleString("es")}–${to.toLocaleString("es")} de ${total.toLocaleString("es")}` : "Cargando…"}</span>
      <label>
        Filas
        <select value={pageSize} disabled={running} onChange={(event) => onPageSize(Number(event.target.value))}>
          {pageSizes.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>
      {running ? (
        <button type="button" onClick={onCancel}>Cancelar</button>
      ) : null}
    </div>
  );
}

export function TreeBranch({
  label,
  open,
  onToggle,
  depth,
  icon,
  active = false,
  actions,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  depth: string;
  icon: ReactNode;
  active?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className={active ? `tree-item schema-row ${depth} active` : `tree-item schema-row ${depth}`}>
        <button type="button" className="tree-toggle" aria-expanded={open} aria-label={open ? `Contraer ${label}` : `Expandir ${label}`} onClick={onToggle}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {icon}
        <button type="button" className="schema-name" onClick={onToggle}>
          <span>{label}</span>
        </button>
        {actions}
      </div>
      {open ? children : null}
    </div>
  );
}

export function ObjectIcon({ kind, size }: { kind: TableSchema["kind"]; size: number }) {
  if (kind === "function" || kind === "procedure") return <Braces size={size} />;
  if (kind === "sequence") return <Hash size={size} />;
  if (kind === "trigger") return <Zap size={size} />;
  if (kind === "index") return <ListTree size={size} />;
  return <Table2 size={size} />;
}


export function TableLeaf({
  table,
  selected,
  className,
  onOpen,
}: {
  table: TableSchema;
  selected: TableSchema | null;
  className: string;
  onOpen: (table: TableSchema, pin?: boolean) => void;
}) {
  const active = selected?.name === table.name && (selected.schema ?? "") === (table.schema ?? "") && selected?.kind === table.kind;
  return (
    <button
      type="button"
      className={active ? `tree-item ${className} active` : `tree-item ${className}`}
      onClick={() => onOpen(table)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpen(table, true);
      }}
    >
      <ObjectIcon kind={table.kind} size={13} /> <span>{table.name}</span>
    </button>
  );
}

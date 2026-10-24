import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TableSchema } from "../lib/api";
import { t } from "../lib/i18n";
import { ObjectIcon } from "./chrome";
import { kindLabel } from "./model";
import { quickMatches } from "./fuzzy";

/** ⌘P: type part of a name to open any table, view or routine. */
export function QuickOpen({ objects, onOpen, onClose }: { objects: TableSchema[]; onOpen: (object: TableSchema) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => quickMatches(objects, query), [objects, query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  const open = (object: TableSchema | undefined) => {
    if (!object) return;
    onClose();
    onOpen(object);
  };
  return (
    <div className="modal-backdrop quick-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="quick-open" role="dialog" aria-label={t("app.quickOpen.title")}>
        <div className="quick-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder={t("app.quickOpen.placeholder")}
            aria-label={t("app.quickOpen.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight((index) => (matches.length === 0 ? 0 : (index + step + matches.length) % matches.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                open(matches[highlight]);
              }
            }}
          />
        </div>
        <div className="quick-list" role="listbox" ref={list}>
          {matches.map((object, index) => (
            <button
              key={`${object.kind}:${object.schema ?? ""}.${object.name}`}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === highlight}
              className={index === highlight ? "quick-item highlighted" : "quick-item"}
              onMouseMove={() => setHighlight(index)}
              onClick={() => open(object)}
            >
              <ObjectIcon kind={object.kind} size={15} />
              <span className="quick-name">{object.name}</span>
              <small>{object.schema ? `${object.schema} · ` : ""}{kindLabel(object.kind)}</small>
            </button>
          ))}
          {matches.length === 0 ? <div className="quick-empty">{t("app.quickOpen.none")}</div> : null}
        </div>
      </div>
    </div>
  );
}

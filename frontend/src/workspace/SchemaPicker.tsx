import { Check, ChevronDown, Layers, Search } from "lucide-react";
import { useState } from "react";
import { formatNumber, t } from "../lib/i18n";
import { useDismiss } from "./useDismiss";

/**
 * Chooses which schema the explorer shows. Databases with dozens of schemas
 * would otherwise bury their tables under one long tree.
 */
export function SchemaPicker({
  schemas,
  counts,
  current,
  all,
  onPick,
  onShowAll,
}: {
  schemas: string[];
  counts: Record<string, number>;
  current: string;
  all: boolean;
  onPick: (schema: string) => void;
  onShowAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const ref = useDismiss(open, close);
  const needle = query.trim().toLowerCase();
  const shown = needle ? schemas.filter((name) => name.toLowerCase().includes(needle)) : schemas;

  return (
    <div className="schema-picker-anchor" ref={ref}>
      <button
        type="button"
        className="schema-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("app.schemaPicker.title")}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Layers size={13} />
        <span>{all ? t("app.schemaPicker.all") : current || t("app.explorer.noSchemas")}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="schema-picker-menu" role="listbox">
          {schemas.length > 8 ? (
            <div className="explorer-search schema-picker-search">
              <Search size={13} />
              <input
                autoFocus
                value={query}
                placeholder={t("app.schemaPicker.search")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && shown.length > 0) {
                    onPick(shown[0]);
                    close();
                  }
                }}
              />
            </div>
          ) : null}
          {needle ? null : (
            <>
              <button
                type="button"
                role="option"
                aria-selected={all}
                onClick={() => {
                  onShowAll();
                  close();
                }}
              >
                <Check size={13} className={all ? undefined : "invisible"} />
                <span>{t("app.schemaPicker.all")}</span>
              </button>
              <div className="temporal-sep" />
            </>
          )}
          <div className="schema-picker-list">
            {shown.map((name) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={!all && name === current}
                onClick={() => {
                  onPick(name);
                  close();
                }}
              >
                <Check size={13} className={!all && name === current ? undefined : "invisible"} />
                <span>{name}</span>
                <small>{formatNumber(counts[name] ?? 0)}</small>
              </button>
            ))}
            {shown.length === 0 ? <div className="schema-picker-empty">{t("app.schemaPicker.none")}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

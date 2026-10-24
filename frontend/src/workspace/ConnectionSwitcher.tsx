import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { useState } from "react";
import { engineOptions } from "../home/engines";
import { subtitle } from "../home/draft";
import type { ConnectionConfig } from "../lib/api";
import { t } from "../lib/i18n";
import { useDismiss } from "./useDismiss";

/**
 * The connection name in the top bar. It opens a list of the saved
 * connections; picking one opens it in its own window, so this one keeps
 * its tabs and edits.
 */
export function ConnectionSwitcher({
  current,
  profiles,
  open,
  onOpenChange,
  onPick,
  onNew,
}: {
  current: ConnectionConfig;
  profiles: ConnectionConfig[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (profile: ConnectionConfig) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const close = () => {
    onOpenChange(false);
    setQuery("");
    setHighlight(0);
  };
  const ref = useDismiss(open, close);
  const needle = query.trim().toLowerCase();
  const shown = profiles.filter((profile) =>
    !needle || [profile.name, profile.database, profile.host ?? "", profile.group ?? ""].some((text) => text.toLowerCase().includes(needle)),
  );
  const pick = (profile: ConnectionConfig) => {
    close();
    if (profile.id !== current.id) onPick(profile);
  };

  return (
    <div className="switcher-anchor" ref={ref}>
      <button
        type="button"
        className="connected-badge switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("app.switcher.title")}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <span className="status-dot online" /> {current.name}
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="switcher-menu">
          <div className="explorer-search switcher-search">
            <Search size={13} />
            <input
              autoFocus
              value={query}
              placeholder={t("app.switcher.search")}
              aria-label={t("app.switcher.search")}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlight((index) => (shown.length === 0 ? 0 : (index + step + shown.length) % shown.length));
                } else if (event.key === "Enter" && shown[highlight]) {
                  event.preventDefault();
                  pick(shown[highlight]);
                }
              }}
            />
          </div>
          <div className="switcher-list" role="listbox">
            {shown.map((profile, index) => {
              const engine = engineOptions().find((item) => item.id === profile.engine);
              const here = profile.id === current.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={index === highlight ? "switcher-item highlighted" : "switcher-item"}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(profile)}
                >
                  <span className="db-icon switcher-icon" style={{ background: engine?.color ?? "#64748b" }}>{engine?.short ?? "DB"}</span>
                  <span className="switcher-text">
                    <span className="switcher-name">{profile.name}</span>
                    <small>{subtitle(profile)}</small>
                  </span>
                  {here ? (
                    <span className="switcher-here"><Check size={13} /> {t("app.switcher.here")}</span>
                  ) : null}
                </button>
              );
            })}
            {shown.length === 0 ? <div className="switcher-empty">{t("app.switcher.none")}</div> : null}
          </div>
          <div className="temporal-sep" />
          <button
            type="button"
            className="switcher-item switcher-new"
            onClick={() => {
              close();
              onNew();
            }}
          >
            <Plus size={14} /> {t("app.switcher.new")}
          </button>
          <div className="switcher-hint">{t("app.switcher.hint")}</div>
        </div>
      ) : null}
    </div>
  );
}

import { X } from "lucide-react";
import { useState } from "react";
import type { SqlValue } from "../lib/api";
import { t } from "../lib/i18n";

/** Last values typed for each parameter name, per connection. */
function readParamValues(connectionId: string): Record<string, string | null> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`gridl.params.${connectionId}`) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

function writeParamValues(connectionId: string, values: Record<string, string | null>) {
  try {
    window.localStorage.setItem(`gridl.params.${connectionId}`, JSON.stringify({ ...readParamValues(connectionId), ...values }));
  } catch {
    // Storage can be full or blocked; the values are a convenience.
  }
}

/** Asks for the value of each `:name` in the SQL about to run. */
export function ParamsDialog({
  connectionId,
  names,
  onClose,
  onRun,
}: {
  connectionId: string;
  names: string[];
  onClose: () => void;
  onRun: (values: Record<string, SqlValue>) => void;
}) {
  const [values, setValues] = useState<Record<string, string | null>>(() => {
    const last = readParamValues(connectionId);
    return Object.fromEntries(names.map((name) => [name, name in last ? (last[name] ?? null) : ""]));
  });
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal small-modal params-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          writeParamValues(connectionId, values);
          onRun(Object.fromEntries(names.map((name) => {
            const value = values[name];
            return [name, value === null || value === undefined ? { t: "null" } : { t: "text", v: value }];
          })));
        }}
      >
        <div className="modal-topline">
          <h2>{t("app.params.title")}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{t("app.params.body")}</p>
        <div className="params-list">
          {names.map((name, index) => {
            const value = values[name];
            const isNull = value === null || value === undefined;
            return (
              <label key={name} className="param-row">
                <span className="param-name">:{name}</span>
                <input
                  autoFocus={index === 0}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={isNull}
                  value={isNull ? "" : value}
                  placeholder={isNull ? "NULL" : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                />
                <button
                  type="button"
                  className={isNull ? "param-null active" : "param-null"}
                  aria-pressed={isNull}
                  title={t("app.params.nullTitle")}
                  onClick={() => setValues((current) => ({ ...current, [name]: isNull ? "" : null }))}
                >
                  NULL
                </button>
              </label>
            );
          })}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button">{t("app.params.run")}</button>
        </div>
      </form>
    </div>
  );
}

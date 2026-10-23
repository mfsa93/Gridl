import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { suggestedSafety, type Environment, type GuardMode, type SafetySettings } from "../lib/api";
import { environments } from "../lib/environments";
import { t } from "../lib/i18n";

const modes: { id: GuardMode; label: string }[] = [
  { id: "allow", label: t("safety.mode.allow") },
  { id: "confirm", label: t("safety.mode.confirm") },
  { id: "block", label: t("safety.mode.block") },
];

function modeLabel(mode: GuardMode): string {
  return modes.find((item) => item.id === mode)?.label.toLowerCase() ?? mode;
}

/** Environment picker with the safety rules folded underneath. */
export function SafetyFields({ safety, onChange }: { safety: SafetySettings; onChange: (safety: SafetySettings) => void }) {
  const [open, setOpen] = useState(false);
  const line = t("safety.summary", {
    writes: modeLabel(safety.writes),
    schema: modeLabel(safety.schema),
    dangerous: safety.confirmDangerous ? t("safety.summary.dangerous") : "",
    limit: safety.timeoutSecs ? t("safety.summary.limit", { seconds: safety.timeoutSecs }) : "",
  });
  return (
    <div className={`safety-block env-${safety.environment}`}>
      <div className="safety-row">
        <label className="env-select">
          <span>{t("safety.environment")}</span>
          <span className="env-dot" />
          <select value={safety.environment} onChange={(event) => onChange(suggestedSafety(event.target.value as Environment))}>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="disclosure safety-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <ChevronRight size={12} className={open ? "open" : undefined} />
          <span>{t("safety.rules")}</span>
          {open ? null : <span className="safety-line">{line}</span>}
        </button>
      </div>
      {open ? (
        <div className="safety-rules">
          <label title={t("safety.writes.hint")}>
            {t("safety.writes")}
            <select value={safety.writes} onChange={(event) => onChange({ ...safety, writes: event.target.value as GuardMode })}>
              {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label title={t("safety.schema.hint")}>
            {t("safety.schema")}
            <select value={safety.schema} onChange={(event) => onChange({ ...safety, schema: event.target.value as GuardMode })}>
              {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label title={t("safety.timeout.hint")}>
            {t("safety.timeout")}
            <span className="input-suffix">
              <input
                value={safety.timeoutSecs ?? ""}
                inputMode="numeric"
                placeholder={t("safety.timeout.placeholder")}
                onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, "");
                  onChange({ ...safety, timeoutSecs: digits ? Math.min(86_400, Number(digits)) : null });
                }}
              />
              <span>s</span>
            </span>
          </label>
          <span />
          <label className="check-row span-2" title={t("safety.dangerous.hint")}>
            <input type="checkbox" checked={safety.confirmDangerous} onChange={(event) => onChange({ ...safety, confirmDangerous: event.target.checked })} />
            {t("safety.dangerous")}
          </label>
        </div>
      ) : null}
    </div>
  );
}

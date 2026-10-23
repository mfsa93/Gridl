import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { suggestedSafety, type Environment, type GuardMode, type SafetySettings } from "../lib/api";
import { environments } from "../lib/environments";

const modes: { id: GuardMode; label: string }[] = [
  { id: "allow", label: "Permitir" },
  { id: "confirm", label: "Pedir autorización" },
  { id: "block", label: "Bloquear" },
];

function modeLabel(mode: GuardMode): string {
  return modes.find((item) => item.id === mode)?.label.toLowerCase() ?? mode;
}

/** Environment picker with the safety rules folded underneath. */
export function SafetyFields({ safety, onChange }: { safety: SafetySettings; onChange: (safety: SafetySettings) => void }) {
  const [open, setOpen] = useState(false);
  const line = `Datos: ${modeLabel(safety.writes)} · Estructura: ${modeLabel(safety.schema)}${safety.confirmDangerous ? " · Destructivas: confirmar" : ""}`;
  return (
    <div className={`safety-block env-${safety.environment}`}>
      <div className="safety-row">
        <label className="env-select">
          <span>Ambiente</span>
          <span className="env-dot" />
          <select value={safety.environment} onChange={(event) => onChange(suggestedSafety(event.target.value as Environment))}>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="disclosure safety-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <ChevronRight size={12} className={open ? "open" : undefined} />
          <span>Reglas de seguridad</span>
          {open ? null : <span className="safety-line">{line}</span>}
        </button>
      </div>
      {open ? (
        <div className="safety-rules">
          <label title="INSERT, UPDATE, DELETE, MERGE y llamadas a procedimientos">
            Modificar datos
            <select value={safety.writes} onChange={(event) => onChange({ ...safety, writes: event.target.value as GuardMode })}>
              {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label title="CREATE, ALTER, DROP, TRUNCATE, GRANT y REVOKE">
            Cambiar estructura
            <select value={safety.schema} onChange={(event) => onChange({ ...safety, schema: event.target.value as GuardMode })}>
              {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label className="check-row span-2" title="El límite por si te equivocas, también en local">
            <input type="checkbox" checked={safety.confirmDangerous} onChange={(event) => onChange({ ...safety, confirmDangerous: event.target.checked })} />
            Confirmar siempre DELETE o UPDATE sin WHERE, DROP y TRUNCATE
          </label>
        </div>
      ) : null}
    </div>
  );
}

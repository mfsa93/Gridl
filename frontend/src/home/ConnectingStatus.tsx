import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

export type ConnectingState = { id: string; stage: "connect" | "schema"; started: number };

/**
 * Sits on the card of the connection being opened, so a slow server never
 * looks like a frozen window and the other connections stay usable.
 */
export function ConnectingStatus({ state, onCancel }: { state: ConnectingState; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - state.started) / 1000));
  const slow = seconds >= 10 ? (state.stage === "schema" ? t("home.connecting.slowSchema") : t("home.connecting.slowServer")) : null;

  return (
    <div className="card-connecting" role="status" aria-live="polite" title={slow ?? undefined}>
      <span className="connecting-spinner" aria-hidden="true" />
      <span className="card-connecting-text">
        {state.stage === "schema" ? t("home.connecting.schema") : t("home.connecting.server")}
        {seconds >= 2 ? ` · ${t("home.connecting.elapsed", { seconds })}` : ""}
        {slow ? <small>{slow}</small> : null}
      </span>
      <button type="button" className="secondary-button" onClick={onCancel}>
        {t("home.connecting.cancel")}
      </button>
    </div>
  );
}

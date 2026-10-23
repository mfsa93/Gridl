import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, listenHere } from "../lib/api";

/** Checked once per app run, even though this component remounts with each screen. */
let checkedAtStartup = false;

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "available"; update: Update; current: string }
  | { kind: "downloading"; update: Update; current: string; done: number; total: number | null }
  | { kind: "failed"; message: string };

/** The updater plugin speaks English and in terms of HTTP; say what it means. */
function updateError(caught: unknown): string {
  const message = errorMessage(caught);
  if (/valid release JSON|404|not found/i.test(message)) {
    return "Todavía no hay ninguna versión publicada en GitHub. Si acabas de crear una, espera a que termine de compilarse.";
  }
  if (/network|dns|connect|timed out|offline|error sending request/i.test(message)) {
    return "No hay conexión con GitHub. Revisa tu conexión a internet e inténtalo de nuevo.";
  }
  if (/signature/i.test(message)) {
    return "La actualización no tiene una firma válida y no se instaló.";
  }
  return message;
}

function isMainWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "main";
  } catch {
    return false;
  }
}

/**
 * Looks for a new release on start and from the menu, then downloads,
 * installs, and restarts. `beforeRestart` gets a chance to keep unsaved edits.
 */
export function UpdateCenter({ beforeRestart }: { beforeRestart: () => Promise<boolean> }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const beforeRestartRef = useRef(beforeRestart);
  useEffect(() => {
    beforeRestartRef.current = beforeRestart;
  });

  const look = useCallback(async (manual: boolean) => {
    if (manual) setState({ kind: "checking" });
    try {
      const [update, current] = await Promise.all([check(), getVersion()]);
      if (update) setState({ kind: "available", update, current });
      else setState(manual ? { kind: "current", version: current } : { kind: "idle" });
    } catch (caught) {
      // A silent check at startup should not bother anyone when offline.
      setState(manual ? { kind: "failed", message: updateError(caught) } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (checkedAtStartup || !isMainWindow()) return undefined;
    checkedAtStartup = true;
    const timer = window.setTimeout(() => void look(false), 4000);
    return () => window.clearTimeout(timer);
  }, [look]);

  useEffect(() => {
    let stop = () => {};
    void listenHere<string>("gridl-command", (event) => {
      if (event.payload === "check-updates") void look(true);
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => stop();
  }, [look]);

  const install = async () => {
    if (state.kind !== "available") return;
    const { update, current } = state;
    if (!(await beforeRestartRef.current())) return;
    let done = 0;
    let total: number | null = null;
    setState({ kind: "downloading", update, current, done, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event === "Progress") done += event.data.chunkLength;
        setState({ kind: "downloading", update, current, done, total });
      });
      await relaunch();
    } catch (caught) {
      setState({ kind: "failed", message: updateError(caught) });
    }
  };

  if (state.kind === "idle") return null;
  const close = () => setState({ kind: "idle" });
  const busy = state.kind === "downloading" || state.kind === "checking";
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : close}>
      <div className="modal update-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-topline">
          <h2>
            {state.kind === "checking" ? "Buscando actualizaciones…"
              : state.kind === "current" ? "Gridl está al día"
                : state.kind === "failed" ? "No se pudo buscar actualizaciones"
                  : `Gridl ${state.update.version} está disponible`}
          </h2>
          {busy ? null : (
            <button type="button" className="close-button" aria-label="Cerrar" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        {state.kind === "current" ? <p className="modal-description">Tienes la versión más reciente ({state.version}).</p> : null}
        {state.kind === "failed" ? <p className="form-error">{state.message}</p> : null}
        {state.kind === "available" || state.kind === "downloading" ? (
          <>
            <p className="modal-description">Tienes la versión {state.current}. Se descarga, se instala y Gridl se reinicia.</p>
            {state.update.body ? <pre className="update-notes">{state.update.body}</pre> : null}
          </>
        ) : null}
        {state.kind === "downloading" ? (
          <div className="update-progress" role="progressbar" aria-valuenow={state.total ? Math.round((state.done / state.total) * 100) : undefined}>
            <span style={{ width: state.total ? `${Math.min(100, (state.done / state.total) * 100)}%` : "35%" }} className={state.total ? undefined : "indeterminate"} />
          </div>
        ) : null}
        <div className="modal-footer">
          {state.kind === "available" ? (
            <>
              <button type="button" className="secondary-button" onClick={close}>Más tarde</button>
              <button type="button" className="primary-button" onClick={() => void install()}>
                <Download size={14} /> Instalar y reiniciar
              </button>
            </>
          ) : state.kind === "downloading" ? (
            <span className="field-hint">Descargando… {(state.done / 1_048_576).toFixed(1)} MB{state.total ? ` de ${(state.total / 1_048_576).toFixed(1)} MB` : ""}</span>
          ) : state.kind === "checking" ? null : (
            <button type="button" className="primary-button" autoFocus onClick={close}>Aceptar</button>
          )}
        </div>
      </div>
    </div>
  );
}

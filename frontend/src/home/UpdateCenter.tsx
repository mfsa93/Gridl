import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, listenHere } from "../lib/api";
import { locale, t } from "../lib/i18n";

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
    return t("update.error.noRelease");
  }
  if (/network|dns|connect|timed out|offline|error sending request/i.test(message)) {
    return t("update.error.offline");
  }
  if (/signature/i.test(message)) {
    return t("update.error.signature");
  }
  return message;
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
            {state.kind === "checking" ? t("update.checking")
              : state.kind === "current" ? t("update.current")
                : state.kind === "failed" ? t("update.failed")
                  : t("update.available", { version: state.update.version })}
          </h2>
          {busy ? null : (
            <button type="button" className="close-button" aria-label={t("update.close")} onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        {state.kind === "current" ? <p className="modal-description">{t("update.currentVersion", { version: state.version })}</p> : null}
        {state.kind === "failed" ? <p className="form-error">{state.message}</p> : null}
        {state.kind === "available" || state.kind === "downloading" ? (
          <>
            <p className="modal-description">{t("update.availableDescription", { version: state.current })}</p>
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
              <button type="button" className="secondary-button" onClick={close}>{t("update.later")}</button>
              <button type="button" className="primary-button" onClick={() => void install()}>
                <Download size={14} /> {t("update.install")}
              </button>
            </>
          ) : state.kind === "downloading" ? (
            <span className="field-hint">
              {state.total
                ? t("update.downloadingOf", { done: megabytes(state.done), total: megabytes(state.total) })
                : t("update.downloading", { done: megabytes(state.done) })}
            </span>
          ) : state.kind === "checking" ? null : (
            <button type="button" className="primary-button" autoFocus onClick={close}>{t("update.ok")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

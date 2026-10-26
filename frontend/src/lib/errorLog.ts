import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { listenHere, writeExport } from "./api";
import { t } from "./i18n";

/** One caught error, kept so the user can export the log and send it. */
export type ErrorEntry = {
  at: string;
  source: string;
  message: string;
  stack: string | null;
};

const storageKey = "gridl.errors";
const maxEntries = 100;
const maxStack = 2000;

function readLog(): ErrorEntry[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Keeps the error, newest last, dropping the oldest past `maxEntries`. */
export function recordError(source: string, error: unknown) {
  const entry: ErrorEntry = {
    at: new Date().toISOString(),
    source,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack.slice(0, maxStack) : null,
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify([...readLog(), entry].slice(-maxEntries)));
  } catch {
    // Storage full or blocked: the error still reaches the console.
  }
}

/** The log as plain text, with what is needed to reproduce it. */
export function errorLogText(entries: ErrorEntry[], version: string, agent: string): string {
  const header = `Gridl ${version}\n${agent}\n`;
  if (entries.length === 0) return `${header}\n${t("errors.none")}\n`;
  const body = entries.map((entry) => [`[${entry.at}] ${entry.source}: ${entry.message}`, entry.stack ?? ""].filter(Boolean).join("\n"));
  return `${header}\n${body.join("\n\n")}\n`;
}

async function exportLog() {
  const day = new Date().toISOString().slice(0, 10);
  const path = await save({ defaultPath: `gridl-errors-${day}.txt`, filters: [{ name: t("errors.filter"), extensions: ["txt"] }] });
  if (!path) return;
  const version = await getVersion().catch(() => "?");
  await writeExport(path, errorLogText(readLog(), version, navigator.userAgent));
}

/** Records uncaught errors and answers Help → Export Error Log in this window. */
export function captureErrors() {
  window.addEventListener("error", (event) => recordError("window", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => recordError("promise", event.reason));
  void listenHere<string>("gridl-command", (event) => {
    if (event.payload === "export-errors") void exportLog().catch((error) => recordError("export", error));
  }).catch(() => undefined);
}

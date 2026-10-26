import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@glideapps/glide-data-grid/dist/index.css";
import { App } from "./App";
import { setEngines } from "./engines";
import { listEngines } from "./lib/api";
import { captureErrors } from "./lib/errorLog";
import { locale, t } from "./lib/i18n";
import "./styles.css";

document.documentElement.lang = locale;
captureErrors();

// The macOS window has an overlay title bar and sidebar vibrancy (see tauri.conf.json).
const isTauri = "__TAURI_INTERNALS__" in window;
if (isTauri && /Mac/.test(navigator.userAgent)) {
  document.documentElement.classList.add("mac-overlay", "vibrant");
}

// The webview's own menu (Reload, Inspect Element) is not part of the app. Text
// fields keep it for copy and paste; in development Option+right click still
// opens it for debugging.
window.addEventListener("contextmenu", (event) => {
  if (import.meta.env.DEV && event.altKey) return;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, .cm-editor, pre, [contenteditable='true']")) return;
  event.preventDefault();
});

const root = document.getElementById("root");
if (!root) {
  throw new Error(t("error.noRoot"));
}

// The window paints at once with the built-in engines; the backend's list
// (the same today, plugins later) replaces it when it arrives.
void listEngines().then(setEngines).catch(() => undefined);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

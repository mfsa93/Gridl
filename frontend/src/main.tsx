import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@glideapps/glide-data-grid/dist/index.css";
import { App } from "./App";
import "./styles.css";

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
  throw new Error("No se encontró #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

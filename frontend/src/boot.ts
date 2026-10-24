import { getCurrentWindow } from "@tauri-apps/api/window";
import { markShown } from "./splash";

// Loaded before the app bundle, after the splash markup in index.html. The
// window opens hidden (tauri.conf.json, windows.rs) and is shown here, so the
// first thing on screen is the splash, never an empty window. A hidden
// WebKit view does not run animation frames, so this cannot wait for one.
if ("__TAURI_INTERNALS__" in window) {
  void getCurrentWindow().show().catch(() => undefined).finally(markShown);
} else {
  markShown();
}

import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";

const query = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function subscribe(onChange: () => void) {
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function snapshot(): ColorScheme {
  return query?.matches ? "dark" : "light";
}

/** Follows the system appearance, like every macOS app does. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}

export function currentColorScheme(): ColorScheme {
  return snapshot();
}

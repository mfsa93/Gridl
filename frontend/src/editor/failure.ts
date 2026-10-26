import { errorMessage } from "../lib/api";

/** The error and where it was thrown, short enough for the status bar. */
export function editorFailure(error: unknown): string {
  const message = errorMessage(error);
  const frame = error instanceof Error ? error.stack?.split("\n").find((line) => line.trim() && !line.includes(message)) : undefined;
  return frame ? `${message} — ${frame.trim()}` : message;
}

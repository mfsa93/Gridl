import { beforeEach, describe, expect, it } from "vitest";
import { errorLogText, recordError, type ErrorEntry } from "../lib/errorLog";
import { editorFailure } from "../editor/failure";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

const stored = () => JSON.parse(localStorage.getItem("gridl.errors") ?? "[]") as ErrorEntry[];

describe("error log", () => {
  beforeEach(() => localStorage.removeItem("gridl.errors"));

  it("keeps errors with their stack, newest last, up to 100", () => {
    for (let i = 0; i < 105; i++) recordError("editor", new Error(`boom ${i}`));
    recordError("promise", "plain reason");
    const log = stored();
    expect(log).toHaveLength(100);
    expect(log[0].message).toBe("boom 6");
    expect(log[98].stack).toContain("boom 104");
    expect(log[99]).toMatchObject({ source: "promise", message: "plain reason", stack: null });
  });

  it("writes the version, the browser and every entry", () => {
    const text = errorLogText([{ at: "2026-10-26T10:00:00.000Z", source: "editor", message: "x", stack: "Error: x\n at f" }], "0.5.2", "WebKit");
    expect(text).toBe("Gridl 0.5.2\nWebKit\n\n[2026-10-26T10:00:00.000Z] editor: x\nError: x\n at f\n");
    expect(errorLogText([], "0.5.2", "WebKit")).toMatch(/^Gridl 0\.5\.2\nWebKit\n\n.+\n$/);
  });

  it("shows the message and where it was thrown", () => {
    const error = new Error("out of range");
    error.stack = "Error: out of range\n    at update (view.js:10:5)\n    at dispatch";
    expect(editorFailure(error)).toBe("out of range — at update (view.js:10:5)");
    expect(editorFailure("text")).toBe("text");
  });
});

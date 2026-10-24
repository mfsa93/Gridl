import { engineSpec } from "../engines";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { forceLinting, lintGutter } from "@codemirror/lint";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { DatabaseEngine } from "../lib/api";
import { useColorScheme, type ColorScheme } from "../lib/appearance";
import { activeSql } from "./activeSql";
import { formatSql } from "./formatSql";
import { forgetChecks, sqlDiagnostics, type SqlChecker } from "./diagnostics";

export type SqlEditorHandle = {
  getValue: () => string;
  getActiveSql: () => string;
  setValue: (sql: string) => void;
  /** Appends `sql` after the current text, selects it, and focuses the editor. */
  insertSql: (sql: string) => void;
  /** Formats the selection, or the whole script when nothing is selected. Throws on SQL it cannot parse. */
  format: () => void;
  /** Drops cached checks and lints again, e.g. after the schema changed. */
  relint: () => void;
};

type SqlEditorProps = {
  engine: DatabaseEngine;
  schema: Record<string, string[]>;
  initialSql?: string;
  onChange?: (sql: string) => void;
  onRun: () => void;
  onRunAll?: () => void;
  onFormat?: () => void;
  /** Parses statements on the server to underline errors while typing. */
  checker?: SqlChecker | null;
  visible?: boolean;
};

const language = new Compartment();
const appearance = new Compartment();

/** Xcode's default light palette for SQL tokens. */
const xcodeLight = HighlightStyle.define([
  { tag: tags.keyword, color: "#9b2393", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "#c41a16" },
  { tag: [tags.number, tags.bool, tags.null], color: "#1c00cf" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#5d6c79", fontStyle: "italic" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "#0b4f79" },
  { tag: [tags.operator, tags.punctuation], color: "#262626" },
  { tag: [tags.special(tags.name), tags.quote], color: "#326d74" },
]);

const lightTheme = EditorView.theme({
  "&": { color: "rgba(0, 0, 0, 0.86)", backgroundColor: "#ffffff" },
  ".cm-content": { caretColor: "#007aff" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#007aff" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#b3d7ff !important" },
  ".cm-activeLine": { backgroundColor: "rgba(0, 122, 255, 0.05)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(0, 122, 255, 0.15)", outline: "none" },
}, { dark: false });

function appearanceExtension(scheme: ColorScheme) {
  return scheme === "dark" ? oneDark : [lightTheme, syntaxHighlighting(xcodeLight)];
}

function sqlExtension(engine: DatabaseEngine, schema: Record<string, string[]>) {
  return sql({
    dialect: { postgresql: PostgreSQL, mysql: MySQL, sqlite: SQLite }[engineSpec(engine).sql.dialect],
    schema,
    upperCaseKeywords: true,
  });
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { engine, schema, initialSql = "", onChange, onRun, onRunAll, onFormat, checker = null, visible = true },
  ref,
) {
  const scheme = useColorScheme();
  const schemeRef = useRef(scheme);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onRunRef = useRef(onRun);
  const onRunAllRef = useRef(onRunAll);
  const onFormatRef = useRef(onFormat);
  const engineRef = useRef(engine);
  const checkerRef = useRef(checker);
  checkerRef.current = checker;
  onFormatRef.current = onFormat;
  engineRef.current = engine;
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onRunAllRef.current = onRunAll;
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    getValue: () => viewRef.current?.state.doc.toString() ?? "",
    getActiveSql: () => {
      const view = viewRef.current;
      if (!view) return "";
      const selection = view.state.selection.main;
      return activeSql(view.state.doc.toString(), selection.from, selection.to);
    },
    setValue: (sql: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: sql },
      });
    },
    format: () => {
      const view = viewRef.current;
      if (!view) return;
      const selection = view.state.selection.main;
      const from = selection.empty ? 0 : selection.from;
      const to = selection.empty ? view.state.doc.length : selection.to;
      const source = view.state.sliceDoc(from, to);
      if (!source.trim()) return;
      const formatted = formatSql(source, engineRef.current);
      view.dispatch({
        changes: { from, to, insert: formatted },
        selection: selection.empty ? undefined : { anchor: from, head: from + formatted.length },
      });
      view.focus();
    },
    relint: () => {
      forgetChecks();
      const view = viewRef.current;
      if (view) forceLinting(view);
    },
    insertSql: (sql: string) => {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      const existing = view.state.doc.toString();
      const separator = existing.trim() === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      const from = existing.trim() === "" ? 0 : length + separator.length;
      view.dispatch({
        changes: existing.trim() === "" ? { from: 0, to: length, insert: sql } : { from: length, insert: `${separator}${sql}` },
        selection: { anchor: from, head: from + sql.length },
        scrollIntoView: true,
      });
      view.focus();
    },
  }));

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return undefined;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialSql,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
          bracketMatching(),
          autocompletion(),
          lintGutter(),
          sqlDiagnostics(() => checkerRef.current),
          appearance.of(appearanceExtension(schemeRef.current)),
          language.of(sqlExtension(engine, schema)),
          Prec.highest(keymap.of([
            {
              key: "Mod-i",
              preventDefault: true,
              run: () => {
                onFormatRef.current?.();
                return true;
              },
            },
            {
              key: "Shift-Mod-Enter",
              preventDefault: true,
              stopPropagation: true,
              run: () => {
                onRunAllRef.current?.();
                return true;
              },
            },
            {
              key: "Mod-Enter",
              preventDefault: true,
              stopPropagation: true,
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ])),
          keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', lineHeight: "1.5" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is mounted once. Schema and dialect updates go through the compartment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: language.reconfigure(sqlExtension(engine, schema)),
    });
  }, [engine, schema]);

  useEffect(() => {
    schemeRef.current = scheme;
    viewRef.current?.dispatch({ effects: appearance.reconfigure(appearanceExtension(scheme)) });
  }, [scheme]);

  useEffect(() => {
    if (visible) viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (document.querySelector(".modal-backdrop")) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, .cm-editor")) return;
      event.preventDefault();
      if (event.shiftKey) onRunAllRef.current?.();
      else onRunRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  return <div ref={hostRef} className="editor-host" />;
});

import DataEditor, {
  CompactSelection,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type Item,
  type ProvideEditorCallback,
  TextCellEntry,
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { formatSqlValue, quoteIdent, type ColumnDefinition, type DatabaseEngine, type SqlValue } from "../lib/api";
import { sqlLiteral, toTsv } from "../workspace/export";
import { useColorScheme, type ColorScheme } from "../lib/appearance";
import { ContextMenu } from "../workspace/panels";
import { canonicalTemporal, formatTemporalPick, isBooleanColumn, isTemporalColumn, temporalInputType, temporalLabel } from "../workspace/changes";

const GRID_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

const BASE_THEME = {
  fontFamily: GRID_FONT,
  headerFontStyle: "600 12px",
  baseFontStyle: "12px",
  editorFontSize: "12px",
};

/** Grid colors for each system appearance, matching AppKit table views. */
const GRID_THEMES: Record<ColorScheme, Partial<Theme>> = {
  light: {
    ...BASE_THEME,
    accentColor: "#007aff",
    accentLight: "rgba(0, 122, 255, 0.14)",
    textDark: "rgba(0, 0, 0, 0.86)",
    textMedium: "rgba(0, 0, 0, 0.6)",
    textLight: "rgba(0, 0, 0, 0.35)",
    textHeader: "rgba(0, 0, 0, 0.6)",
    textHeaderSelected: "#ffffff",
    bgCell: "#ffffff",
    bgCellMedium: "#f5f5f7",
    bgHeader: "#f6f6f6",
    bgHeaderHasFocus: "#e9e9eb",
    bgHeaderHovered: "#ededef",
    bgBubble: "#f2f2f4",
    bgSearchResult: "rgba(255, 204, 0, 0.3)",
    borderColor: "rgba(0, 0, 0, 0.08)",
    horizontalBorderColor: "rgba(0, 0, 0, 0.05)",
    drilldownBorder: "rgba(0, 0, 0, 0.1)",
    linkColor: "#007aff",
  },
  dark: {
    ...BASE_THEME,
    accentColor: "#0a84ff",
    accentLight: "rgba(10, 132, 255, 0.28)",
    textDark: "rgba(255, 255, 255, 0.88)",
    textMedium: "rgba(255, 255, 255, 0.6)",
    textLight: "rgba(255, 255, 255, 0.35)",
    textHeader: "rgba(255, 255, 255, 0.6)",
    textHeaderSelected: "#ffffff",
    bgCell: "#1e1e1e",
    bgCellMedium: "#252527",
    bgHeader: "#2a2a2a",
    bgHeaderHasFocus: "#333335",
    bgHeaderHovered: "#303032",
    bgBubble: "#333335",
    bgSearchResult: "rgba(255, 214, 10, 0.3)",
    borderColor: "rgba(255, 255, 255, 0.08)",
    horizontalBorderColor: "rgba(255, 255, 255, 0.05)",
    drilldownBorder: "rgba(255, 255, 255, 0.12)",
    linkColor: "#0a84ff",
  },
};

const CELL_THEMES: Record<ColorScheme, { null: Partial<Theme>; draft: Partial<Theme>; removed: Partial<Theme> }> = {
  light: {
    null: { textDark: "rgba(0, 0, 0, 0.3)" },
    draft: { bgCell: "#e8f2ff", bgCellMedium: "#dceaff" },
    removed: { bgCell: "#ffe9e7", bgCellMedium: "#ffdeda", textDark: "#c4271d" },
  },
  dark: {
    null: { textDark: "rgba(255, 255, 255, 0.3)" },
    draft: { bgCell: "#14304f", bgCellMedium: "#173658" },
    removed: { bgCell: "#3d1e1c", bgCellMedium: "#452220", textDark: "#ff8a80" },
  },
};

type ResultGridProps = {
  columns: ColumnDefinition[];
  rowCount: number;
  rowsRef: RefObject<SqlValue[][]>;
  selectable?: boolean;
  inserts?: SqlValue[][];
  removed?: number[];
  edits?: Record<number, SqlValue[]>;
  onEditInsert?: (row: number, column: number, value: SqlValue) => void;
  onEditCell?: (row: number, column: number, value: SqlValue) => void;
  onSelectRows?: (rows: number[]) => void;
  onOpenRow?: (row: number) => void;
  onPasteRows?: (startColumn: number, rows: string[][]) => void;
  onInteract?: () => void;
  onMarkRows?: (rows: number[]) => void;
  onDropInserts?: (rows: number[]) => void;
  /** Row under the cell cursor, or null when nothing is focused. */
  onFocusRow?: (row: number | null) => void;
  sort?: { column: string; direction: "asc" | "desc" } | null;
  onSort?: (column: string) => void;
  /** Foreign key columns; their headers get a link mark. */
  linkedColumns?: string[];
  /** Right click on a cell, with the pointer position and the selection it falls in. */
  onCellMenu?: (row: number, column: number, point: { x: number; y: number }, selection: GridRangeActions | null) => void;
};

/** A multi-cell selection and what can be done with it, handed to the context menu. */
export type GridRangeActions = {
  rows: number;
  cells: number;
  copy: (withHeaders: boolean) => void;
  copyInserts: (table: string, engine: DatabaseEngine) => void;
  paste: () => void;
  clear: () => void;
  removeRows: () => void;
};

type Rect = { x: number; y: number; width: number; height: number };

/** The selected rectangle: a cell range, whole rows, or whole columns. */
function selectedRect(selection: GridSelection, columnCount: number, rowTotal: number): Rect | null {
  const range = selection.current?.range;
  if (range && range.width > 0 && range.height > 0) return { x: Math.max(0, range.x), y: range.y, width: range.width, height: range.height };
  const rows = selection.rows.toArray();
  if (rows.length > 0) {
    const first = Math.min(...rows);
    return { x: 0, y: first, width: columnCount, height: Math.max(...rows) - first + 1 };
  }
  const columns = selection.columns.toArray().filter((column) => column >= 0);
  if (columns.length > 0) {
    const first = Math.min(...columns);
    return { x: first, y: 0, width: Math.max(...columns) - first + 1, height: rowTotal };
  }
  return null;
}

const MIN_AUTO_WIDTH = 64;
const MAX_AUTO_WIDTH = 420;
/** Rows sampled per column; enough to size the column without walking a huge result. */
const SAMPLE_ROWS = 300;
/** Longest cell text measured; anything longer hits the maximum width anyway. */
const SAMPLE_CHARS = 120;

let measureContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (measureContext === undefined) measureContext = document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/** Fits each column to its header and the first rows, like double-clicking a column edge in Numbers. */
function fitColumnWidths(columns: ColumnDefinition[], rows: SqlValue[][], titles: string[]): number[] {
  const sample = rows.slice(0, SAMPLE_ROWS);
  return columns.map((column, index) => {
    let widest = textWidth(titles[index] ?? column.name, `600 12px ${GRID_FONT}`) + 28;
    for (const row of sample) {
      const value = row[index];
      const text = !value || value.t === "null" ? "NULL" : cellDisplay(value).slice(0, SAMPLE_CHARS);
      const width = textWidth(text, `12px ${GRID_FONT}`) + 20;
      if (width > widest) widest = width;
      if (widest >= MAX_AUTO_WIDTH) break;
    }
    return Math.round(Math.min(MAX_AUTO_WIDTH, Math.max(MIN_AUTO_WIDTH, widest)));
  });
}

/** Characters drawn per cell. Copy and the editor still get the full value. */
const DRAW_CHARS = 300;

function clip(text: string): string {
  return text.length > DRAW_CHARS ? `${text.slice(0, DRAW_CHARS)}…` : text;
}

/** What each column needs to draw its cells, worked out once per column instead of per cell. */
type ColumnMeta = {
  temporal: boolean;
  temporalType: string;
  choices: string[];
  hasDefault: boolean;
};

function columnMeta(column: ColumnDefinition): ColumnMeta {
  const temporal = isTemporalColumn(column);
  return { temporal, temporalType: column.dataType, choices: columnChoices(column), hasDefault: Boolean(column.defaultValue) };
}

function sameValue(left: SqlValue | undefined, right: SqlValue | undefined): boolean {
  if (!left || left.t === "null") return !right || right.t === "null";
  if (!right || right.t === "null") return false;
  return left.t === right.t && left.v === right.v;
}

function cellDisplay(value: SqlValue | undefined): string {
  if (!value || value.t === "null") return "";
  if (value.t === "text") {
    const label = temporalLabel(value.v);
    if (label) return label;
  }
  return formatSqlValue(value);
}

const NO_ROWS: SqlValue[][] = [];
const NO_INDEXES: number[] = [];

const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

function dataColumns(selection: GridSelection): number[] {
  return selection.columns.toArray();
}

function pastedSql(text: string, column?: ColumnDefinition): SqlValue {
  const trimmed = text.trim();
  if (trimmed === "") return { t: "null" };
  if (column && isTemporalColumn(column)) {
    const marker = canonicalTemporal(trimmed);
    if (marker === "null") return { t: "text", v: "null" };
    if (marker) return { t: "text", v: marker };
    return { t: "text", v: text };
  }
  if (trimmed.toUpperCase() === "NULL") return { t: "null" };
  if (column && trimmed.toLowerCase() === "default" && ((column.options ?? []).length > 0 || isBooleanColumn(column))) {
    return { t: "text", v: "default" };
  }
  return { t: "text", v: text };
}

function columnChoices(column: ColumnDefinition | undefined): string[] {
  if (!column || isTemporalColumn(column)) return [];
  if ((column.options ?? []).length > 0) return column.options;
  if (isBooleanColumn(column)) return ["true", "false"];
  return [];
}

const temporalChoices = [
  { id: "null", label: "NULL", data: "NULL" },
  { id: "default", label: "DEFAULT", data: "DEFAULT" },
  { id: "now()", label: "NOW()", data: "NOW()" },
] as const;

function TemporalMenu({
  value,
  onChange,
  onFinishedEditing,
  isHighlighted,
  validatedSelection,
  dataType,
}: {
  value: GridCell;
  onChange: (newValue: GridCell) => void;
  onFinishedEditing: (newValue?: GridCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  isHighlighted: boolean;
  validatedSelection?: number | readonly [number, number];
  dataType: string;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState(false);
  if (value.kind !== GridCellKind.Text) return null;
  const hasDefault = "temporalDefault" in value && (value as { temporalDefault?: boolean }).temporalDefault === true;
  const marker = canonicalTemporal(value.data);
  const current = marker ?? (value.data === "" ? (hasDefault ? "default" : "null") : null);
  const finish = (data: string) => onFinishedEditing({ ...value, data }, [0, 0]);
  const inputType = temporalInputType({ name: "", dataType, nullable: true, primaryKey: false, defaultValue: null, options: [] }) ?? "datetime-local";
  const openPicker = () => {
    const input = pickerRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  };
  if (manual) {
    return (
      <div className="temporal-menu manual">
        <TextCellEntry
          highlight={isHighlighted}
          autoFocus
          altNewline
          placeholder="2026-09-29 14:15:00"
          value={current ? "" : value.data}
          validatedSelection={validatedSelection}
          onChange={(event) => onChange({ ...value, data: event.target.value })}
        />
      </div>
    );
  }
  return (
    <div
      className="temporal-menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Tab") event.stopPropagation();
      }}
    >
      {temporalChoices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="menuitem"
          className={current === choice.id ? "current" : undefined}
          onClick={() => finish(choice.data)}
        >
          {choice.label}
        </button>
      ))}
      <div className="temporal-sep" />
      <button type="button" role="menuitem" onClick={openPicker}>Selector de fecha…</button>
      <button type="button" role="menuitem" onClick={() => setManual(true)}>Entrada manual…</button>
      <input
        ref={pickerRef}
        type={inputType}
        className="temporal-native"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.value) finish(formatTemporalPick(dataType, event.target.value));
        }}
      />
    </div>
  );
}

const menuEditorStyle = {
  disablePadding: true,
  disableStyling: true,
  styleOverride: {
    marginLeft: "var(--d19meir1-2)",
    overflow: "visible",
    background: "transparent",
    boxShadow: "none",
    minWidth: "0",
    width: "max-content",
    maxWidth: "none",
    padding: "0",
    animation: "none",
  },
} as const;

function ChoiceMenu({
  value,
  onChange,
  onFinishedEditing,
  options,
}: {
  value: GridCell;
  onChange: (newValue: GridCell) => void;
  onFinishedEditing: (newValue?: GridCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  options: string[];
}) {
  const [manual, setManual] = useState(false);
  if (value.kind !== GridCellKind.Text) return null;
  const hasDefault = "choiceDefault" in value && (value as { choiceDefault?: boolean }).choiceDefault === true;
  const marker = canonicalTemporal(value.data);
  const current = marker ?? (options.includes(value.data) ? value.data : (value.data === "" ? (hasDefault ? "default" : "null") : null));
  const finish = (data: string) => onFinishedEditing({ ...value, data }, [0, 0]);
  if (manual) {
    return (
      <div className="temporal-menu manual">
        <TextCellEntry
          highlight
          autoFocus
          altNewline
          placeholder="valor"
          value={current ? "" : value.data}
          onChange={(event) => onChange({ ...value, data: event.target.value })}
        />
      </div>
    );
  }
  return (
    <div
      className="temporal-menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Tab") event.stopPropagation();
      }}
    >
      <button type="button" role="menuitem" className={current === "null" ? "current" : undefined} onClick={() => finish("NULL")}>NULL</button>
      <button type="button" role="menuitem" className={current === "default" ? "current" : undefined} onClick={() => finish("DEFAULT")}>DEFAULT</button>
      <div className="temporal-sep" />
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="menuitem"
          className={current === option ? "current" : undefined}
          onClick={() => finish(option)}
        >
          {option}
        </button>
      ))}
      <div className="temporal-sep" />
      <button type="button" role="menuitem" onClick={() => setManual(true)}>Entrada manual…</button>
    </div>
  );
}

const provideCellEditor: ProvideEditorCallback<GridCell> = (cell) => {
  if (cell.kind !== GridCellKind.Text) return undefined;
  if ("temporalType" in cell) {
    const dataType = String((cell as { temporalType?: string }).temporalType ?? "");
    return { ...menuEditorStyle, editor: (props) => <TemporalMenu {...props} dataType={dataType} /> };
  }
  if (!("choiceOptions" in cell)) return undefined;
  const options = (cell as { choiceOptions?: string[] }).choiceOptions ?? [];
  if (options.length === 0) return undefined;
  return { ...menuEditorStyle, editor: (props) => <ChoiceMenu {...props} options={options} /> };
};

function pastedLine(columns: ColumnDefinition[], startColumn: number, cells: readonly string[]): SqlValue[] {
  return columns.map((column, index) => {
    const offset = index - startColumn;
    if (offset < 0 || offset >= cells.length) return { t: "null" };
    return pastedSql(cells[offset] ?? "", column);
  });
}

function isHeaderRow(cells: readonly string[], columns: ColumnDefinition[], startColumn: number): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell, index) => {
    const name = columns[startColumn + index]?.name;
    return Boolean(name) && cell.trim().toLowerCase() === name.toLowerCase();
  });
}

export function ResultGrid({
  columns,
  rowCount,
  rowsRef,
  selectable = false,
  inserts = NO_ROWS,
  removed = NO_INDEXES,
  edits,
  onEditInsert,
  onEditCell,
  onSelectRows,
  onOpenRow,
  onPasteRows,
  onInteract,
  onMarkRows,
  onDropInserts,
  onFocusRow,
  sort,
  onSort,
  linkedColumns,
  onCellMenu,
}: ResultGridProps) {
  const scheme = useColorScheme();
  const cellThemes = CELL_THEMES[scheme];
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DataEditorRef>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const columnKey = `${columns.map((column) => column.name).join("\0")}:${rowCount}`;
  const [localScope, setLocalScope] = useState(columnKey);
  const [localEdits, setLocalEdits] = useState<Record<number, SqlValue[]>>({});
  const [localInserts, setLocalInserts] = useState<SqlValue[][]>([]);
  const [gridSelection, setGridSelection] = useState<GridSelection>(emptySelection);
  if (localScope !== columnKey) {
    setLocalScope(columnKey);
    setLocalEdits({});
    setLocalInserts([]);
    setGridSelection(emptySelection);
  }
  const removedSet = useMemo(() => new Set(removed), [removed]);
  const external = Boolean(onEditCell || onEditInsert);
  const shownEdits = onEditCell ? edits : localEdits;
  const shownInserts = external ? inserts : localInserts;
  const insertCount = shownInserts.length;

  useEffect(() => {
    if (insertCount === 0) return;
    editorRef.current?.scrollTo(0, rowCount + insertCount - 1, "vertical");
  }, [insertCount, rowCount]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const measure = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const linkedKey = linkedColumns?.join("\u0000") ?? "";
  const titles = useMemo(() => columns.map((column) => {
    const arrow = sort?.column === column.name ? (sort.direction === "asc" ? " ▲" : " ▼") : "";
    const link = linkedKey.split("\u0000").includes(column.name) ? " ↗" : "";
    return `${column.name}${link}${arrow}`;
  }), [columns, linkedKey, sort]);
  // Refit when the columns or the loaded rows change; widths the user dragged win.
  const [fitted, setFitted] = useState<{ key: string; widths: number[] }>({ key: "", widths: [] });
  const fitKey = `${columnKey}:${titles.join("\u0000")}`;
  useLayoutEffect(() => {
    setFitted({ key: fitKey, widths: fitColumnWidths(columns, rowsRef.current ?? [], titles) });
  }, [columns, fitKey, rowsRef, titles]);
  const [headerMenu, setHeaderMenu] = useState<{ column: number; x: number; y: number } | null>(null);
  /** Drops manual widths so the columns go back to fitting their content. */
  const refit = useCallback((only?: number) => {
    setWidths((current) => {
      if (only === undefined) return {};
      const next = { ...current };
      delete next[`${only}:${columns[only]?.name ?? ""}`];
      return next;
    });
    setFitted({ key: fitKey, widths: fitColumnWidths(columns, rowsRef.current ?? [], titles) });
  }, [columns, fitKey, rowsRef, titles]);
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((column, index) => {
        const id = `${index}:${column.name}`;
        return {
          id,
          title: titles[index] ?? column.name,
          width: widths[id] ?? fitted.widths[index] ?? 120,
        };
      }),
    [columns, fitted, titles, widths],
  );

  const onColumnResize = useCallback((column: GridColumn, newSize: number) => {
    if (!column.id) return;
    const id = column.id;
    setWidths((current) => (current[id] === newSize ? current : { ...current, [id]: newSize }));
  }, []);

  const selectionRef = useRef(gridSelection);
  const onGridSelectionChange = useCallback((selection: GridSelection) => {
    selectionRef.current = selection;
    setGridSelection(selection);
    onSelectRows?.(selection.rows.toArray());
    const focused = selection.current?.cell[1] ?? selection.rows.first();
    onFocusRow?.(focused ?? null);
  }, [onFocusRow, onSelectRows]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const onPasteEvent = (event: ClipboardEvent) => {
      const selection = selectionRef.current;
      if (!external || selection.current !== undefined || selection.rows.length < 2) return;
      const editing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (editing) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      event.preventDefault();
      event.stopPropagation();
      const matrix = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
      if (onPasteRows) onPasteRows(0, matrix);
      else {
        setLocalInserts((current) => [...current, ...matrix.map((line) => pastedLine(columns, 0, line))]);
      }
    };
    element.addEventListener("paste", onPasteEvent);
    return () => element.removeEventListener("paste", onPasteEvent);
  }, [columns, external, onPasteRows]);

  const valueAt = useCallback((row: number, column: number): SqlValue | undefined => {
    const draftIndex = row - rowCount;
    if (draftIndex >= 0) return shownInserts[draftIndex]?.[column];
    return shownEdits?.[row]?.[column] ?? rowsRef.current?.[row]?.[column];
  }, [rowCount, rowsRef, shownEdits, shownInserts]);

  const commitValue = useCallback((row: number, column: number, value: SqlValue) => {
    // Without an owner for the edits (read-only, blocked, or no key), the grid only shows data.
    if (!external) return;
    if (column < 0 || column >= columns.length || removedSet.has(row)) return;
    const draftIndex = row - rowCount;
    if (draftIndex >= 0) {
      if (onEditInsert) onEditInsert(draftIndex, column, value);
      else {
        setLocalInserts((current) => current.map((line, index) => {
          if (index !== draftIndex) return line;
          const next = line.slice();
          next[column] = value;
          return next;
        }));
      }
      return;
    }
    if (onEditCell) {
      onEditCell(row, column, value);
      return;
    }
    setLocalEdits((current) => {
      const base = (current[row] ?? rowsRef.current?.[row] ?? []).slice();
      while (base.length < columns.length) base.push({ t: "null" });
      base[column] = value;
      return { ...current, [row]: base };
    });
  }, [columns.length, external, onEditCell, onEditInsert, removedSet, rowCount, rowsRef]);

  const onDelete = useCallback((selection: GridSelection) => {
    if (!external) return false;
    const marked = selection.rows.toArray();
    if (marked.length > 0 && (onMarkRows || onDropInserts)) {
      const loaded = marked.filter((row) => row < rowCount);
      const drafted = marked.filter((row) => row >= rowCount).map((row) => row - rowCount);
      if (loaded.length > 0) onMarkRows?.(loaded);
      if (drafted.length > 0) onDropInserts?.(drafted);
      return false;
    }
    const columnsSelected = dataColumns(selection);
    if (columnsSelected.length > 0) {
      const total = rowCount + shownInserts.length;
      for (let row = 0; row < total; row += 1) {
        for (const column of columnsSelected) commitValue(row, column, { t: "null" });
      }
      return false;
    }
    const range = selection.current?.range;
    if (!range || range.width <= 0 || range.height <= 0) return false;
    if (range.height > 1 && (onMarkRows || onDropInserts)) {
      // Several rows selected: Delete removes the rows, like a row selection does.
      const touched = Array.from({ length: range.height }, (_, offset) => range.y + offset);
      const loaded = touched.filter((row) => row < rowCount && !removedSet.has(row));
      const drafted = touched.filter((row) => row >= rowCount).map((row) => row - rowCount);
      if (loaded.length > 0) onMarkRows?.(loaded);
      if (drafted.length > 0) onDropInserts?.(drafted);
      return false;
    }
    const startColumn = range.x;
    for (let row = range.y; row < range.y + range.height; row += 1) {
      for (let column = startColumn; column < startColumn + range.width; column += 1) {
        if (column >= 0) commitValue(row, column, { t: "null" });
      }
    }
    return false;
  }, [commitValue, external, onDropInserts, onMarkRows, removedSet, rowCount, shownInserts.length]);

  const appendRows = useCallback((matrix: string[][]) => {
    if (matrix.length === 0) return;
    if (onPasteRows) onPasteRows(0, matrix);
    else setLocalInserts((current) => [...current, ...matrix.map((line) => pastedLine(columns, 0, line))]);
  }, [columns, onPasteRows]);

  const onPaste = useCallback((target: Item, values: readonly (readonly string[])[]) => {
    if (!external) return false;
    const editing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    if (editing) return false;
    const picked = selectionRef.current;
    if (picked.current === undefined && picked.rows.length > 0) {
      appendRows(values.map((row) => [...row]));
      return false;
    }
    const startColumn = target[0];
    const startRow = target[1];
    let matrix = values.map((row) => [...row]);
    if (isHeaderRow(matrix[0] ?? [], columns, startColumn)) matrix = matrix.slice(1);
    const total = rowCount + shownInserts.length;
    const overflow: string[][] = [];
    for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
      const line = matrix[rowOffset] ?? [];
      const row = startRow + rowOffset;
      if (row >= total) {
        overflow.push(line);
        continue;
      }
      line.forEach((text, columnOffset) => {
        commitValue(row, startColumn + columnOffset, pastedSql(text, columns[startColumn + columnOffset]));
      });
    }
    if (overflow.length > 0) {
      if (onPasteRows) onPasteRows(startColumn, overflow);
      else {
        setLocalInserts((current) => [...current, ...overflow.map((line) => pastedLine(columns, startColumn, line))]);
      }
    }
    return false;
  }, [appendRows, columns, commitValue, external, onPasteRows, rowCount, shownInserts.length]);

  /** Actions for the rectangle `rect`, used by the context menu. */
  const rangeActions = useCallback((rect: Rect): GridRangeActions => {
    const columnIndexes = Array.from({ length: rect.width }, (_, offset) => rect.x + offset).filter((column) => column < columns.length);
    const rowIndexes = Array.from({ length: rect.height }, (_, offset) => rect.y + offset);
    const picked = columnIndexes.map((column) => columns[column]).filter((column): column is ColumnDefinition => Boolean(column));
    const values = () => rowIndexes.map((row) => columnIndexes.map((column) => valueAt(row, column) ?? { t: "null" as const }));
    const write = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);
    return {
      rows: rowIndexes.length,
      cells: rowIndexes.length * columnIndexes.length,
      copy: (withHeaders) => write(toTsv(picked, values(), withHeaders)),
      copyInserts: (table, engine) => {
        const names = picked.map((column) => quoteIdent(column.name)).join(", ");
        write(values().map((row) => `INSERT INTO ${table} (${names}) VALUES (${row.map((value) => sqlLiteral(value, engine)).join(", ")});`).join("\n"));
      },
      paste: () => {
        void navigator.clipboard?.readText().then((text) => {
          if (!text) return;
          const matrix = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
          onPaste([rect.x, rect.y], matrix);
        }).catch(() => undefined);
      },
      clear: () => {
        for (const row of rowIndexes) for (const column of columnIndexes) commitValue(row, column, { t: "null" });
      },
      removeRows: () => {
        const loaded = rowIndexes.filter((row) => row < rowCount && !removedSet.has(row));
        const drafted = rowIndexes.filter((row) => row >= rowCount).map((row) => row - rowCount);
        if (loaded.length > 0) onMarkRows?.(loaded);
        if (drafted.length > 0) onDropInserts?.(drafted);
      },
    };
  }, [columns, commitValue, onDropInserts, onMarkRows, onPaste, removedSet, rowCount, valueAt]);

  const metas = useMemo(() => columns.map(columnMeta), [columns]);

  // Called for every visible cell on every frame while scrolling: keep it cheap.
  const getCellContent = useCallback((cell: Item): GridCell => {
    const [col, row] = cell;
    const draftIndex = row - rowCount;
    const drafting = draftIndex >= 0 && draftIndex < shownInserts.length;
    const marked = removedSet.has(row);
    const editedRow = drafting ? undefined : shownEdits?.[row];
    const original = rowsRef.current?.[row]?.[col];
    const value = drafting ? shownInserts[draftIndex]?.[col] : (editedRow?.[col] ?? original);
    const changed = editedRow !== undefined && !sameValue(value, original);
    const blank = !value || value.t === "null";
    let themeOverride: Partial<Theme> | undefined;
    if (drafting || changed) themeOverride = cellThemes.draft;
    else if (marked) themeOverride = cellThemes.removed;
    else if (blank) themeOverride = cellThemes.null;
    const meta = metas[col];
    const extra = meta?.temporal
      ? { temporalType: meta.temporalType, temporalDefault: meta.hasDefault }
      : meta && meta.choices.length > 0
        ? { choiceOptions: meta.choices, choiceDefault: meta.hasDefault }
        : null;
    const readonly = marked || !external;
    if (!value || value.t === "null") {
      return {
        kind: GridCellKind.Text,
        data: "",
        displayData: drafting && meta?.hasDefault ? "DEFAULT" : drafting ? "" : "NULL",
        allowOverlay: !marked,
        readonly,
        themeOverride: themeOverride ?? cellThemes.null,
        ...extra,
      } as GridCell;
    }
    // Markers like NOW() only appear in values the user typed, never in loaded rows.
    const typed = drafting || changed;
    const text = value.t === "text" ? (typed ? (temporalLabel(value.v) ?? value.v) : value.v) : formatSqlValue(value);
    return {
      kind: GridCellKind.Text,
      data: text,
      displayData: clip(text),
      allowOverlay: !marked,
      readonly,
      contentAlign: value.t === "int" || value.t === "float" ? "right" : "left",
      themeOverride,
      ...extra,
    } as GridCell;
  }, [cellThemes, external, metas, removedSet, rowCount, rowsRef, shownEdits, shownInserts]);

  const onCellEdited = useCallback((cell: Item, newValue: EditableGridCell) => {
    if (newValue.kind !== GridCellKind.Text) return;
    commitValue(cell[1], cell[0], pastedSql(newValue.data, columns[cell[0]]));
  }, [columns, commitValue]);

  return (
    <div ref={wrapRef} className="grid-wrap">
      {size.width > 0 && size.height > 0 ? (
        <DataEditor
          ref={editorRef}
          columns={gridColumns}
          rows={rowCount + shownInserts.length}
          getCellContent={getCellContent}
          width={size.width}
          height={size.height}
          rowMarkers={selectable ? "clickable-number" : "number"}
          rowSelect={selectable ? "multi" : "none"}
          columnSelect="multi"
          rangeSelect="rect"
          cellActivationBehavior="double-click"
          gridSelection={gridSelection}
          rowHeight={26}
          headerHeight={28}
          minColumnWidth={48}
          maxColumnWidth={2400}
          onColumnResize={onColumnResize}
          onCellEdited={onCellEdited}
          provideEditor={provideCellEditor}
          onDelete={onDelete}
          onPaste={onPaste}
          onGridSelectionChange={onGridSelectionChange}
          onHeaderContextMenu={(column, event) => {
            event.preventDefault();
            setHeaderMenu({ column, x: event.bounds.x + event.localEventX, y: event.bounds.y + event.localEventY });
          }}
          onCellContextMenu={onCellMenu ? (cell, event) => {
            event.preventDefault();
            const [column, row] = cell;
            if (column < 0 || row < 0) return;
            const point = { x: event.bounds.x + event.localEventX, y: event.bounds.y + event.localEventY };
            const rect = selectedRect(selectionRef.current, columns.length, rowCount + shownInserts.length);
            const inside = rect !== null
              && column >= rect.x && column < rect.x + rect.width
              && row >= rect.y && row < rect.y + rect.height
              && rect.width * rect.height > 1;
            if (inside && rect) {
              onCellMenu(row, column, point, rangeActions(rect));
              return;
            }
            setGridSelection({
              columns: CompactSelection.empty(),
              rows: CompactSelection.empty(),
              current: { cell, range: { x: column, y: row, width: 1, height: 1 }, rangeStack: [] },
            });
            onFocusRow?.(row);
            onCellMenu(row, column, point, null);
          } : undefined}
          onHeaderClicked={onSort ? (column) => {
            const name = columns[column]?.name;
            if (name) onSort(name);
          } : undefined}
          onCellActivated={(cell) => {
            onInteract?.();
            if (!onOpenRow || onEditCell) return;
            if (cell[1] >= rowCount || removedSet.has(cell[1])) return;
            onOpenRow(cell[1]);
          }}
          smoothScrollX
          smoothScrollY
          getCellsForSelection
          theme={GRID_THEMES[scheme]}
        />
      ) : null}
      {headerMenu ? (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            { label: "Ajustar esta columna al contenido", run: () => refit(headerMenu.column) },
            { label: "Ajustar todas las columnas", run: () => refit() },
            ...(onSort && columns[headerMenu.column]
              ? ["separator" as const, { label: "Ordenar por esta columna", run: () => onSort(columns[headerMenu.column]?.name ?? "") }]
              : []),
          ]}
        />
      ) : null}
    </div>
  );
}

import { Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, previewCsv, quoteIdent, type CsvPreview, type TableSchema } from "../lib/api";
import { isGeneratedColumn } from "./changes";
import { plural, t } from "../lib/i18n";

const delimiters = [
  { value: ",", label: t("import.delimiter.comma") },
  { value: ";", label: t("import.delimiter.semicolon") },
  { value: "\t", label: t("import.delimiter.tab") },
  { value: "|", label: t("import.delimiter.pipe") },
];

export type ImportPlan = {
  delimiter: string;
  hasHeader: boolean;
  columns: string[];
  mapping: number[];
  nullToken: string | null;
};

/** Maps the columns of a CSV file onto a table before importing it in one transaction. */
export function ImportDialog({
  path,
  table,
  busy,
  progress,
  error,
  onClose,
  onImport,
}: {
  path: string;
  table: TableSchema;
  busy: boolean;
  progress: number | null;
  error: string | null;
  onClose: () => void;
  onImport: (plan: ImportPlan) => void;
}) {
  const [delimiter, setDelimiter] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [nullToken, setNullToken] = useState("NULL");
  const [mapping, setMapping] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let live = true;
    void previewCsv(path, delimiter)
      .then((next) => {
        if (!live) return;
        setPreview(next);
        setProblem(null);
        // Match table columns to CSV headers by name; generated columns stay empty.
        const headers = next.headers.map((header) => header.trim().toLowerCase());
        setMapping(Object.fromEntries(table.columns.map((column) => {
          const index = headers.indexOf(column.name.toLowerCase());
          return [column.name, index >= 0 ? index : null];
        })));
      })
      .catch((caught: unknown) => live && setProblem(errorMessage(caught)));
    return () => {
      live = false;
    };
  }, [delimiter, path, table.columns]);

  const sourceColumns = useMemo(() => {
    if (!preview) return [];
    const width = Math.max(preview.headers.length, ...preview.rows.map((row) => row.length));
    return Array.from({ length: width }, (_, index) => (hasHeader ? preview.headers[index] : undefined) || t("import.sourceColumn", { number: index + 1 }));
  }, [hasHeader, preview]);
  const sampleRows = preview ? (hasHeader ? preview.rows : [preview.headers, ...preview.rows]).slice(0, 5) : [];
  const mapped = table.columns.filter((column) => mapping[column.name] !== null && mapping[column.name] !== undefined);
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const total = preview?.totalRows === null || preview?.totalRows === undefined ? null : Math.max(0, preview.totalRows - (hasHeader ? 1 : 0));

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <form
        className="modal import-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!preview || mapped.length === 0) return;
          onImport({
            delimiter: preview.delimiter,
            hasHeader,
            columns: mapped.map((column) => quoteIdent(column.name)),
            mapping: mapped.map((column) => mapping[column.name] ?? 0),
            nullToken: nullToken.trim() ? nullToken : null,
          });
        }}
      >
        <div className="modal-topline">
          <h2>{t("import.title", { table: table.name })}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">
          {total !== null ? plural("import.descriptionRows", total, { file: fileName }) : t("import.description", { file: fileName })}
        </p>
        <div className="import-options">
          <label>
            {t("import.delimiter")}
            <select value={preview?.delimiter ?? delimiter ?? ","} onChange={(event) => setDelimiter(event.target.value)}>
              {delimiters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            {t("import.nullToken")}
            <input value={nullToken} placeholder={t("import.nullTokenPlaceholder")} autoCorrect="off" onChange={(event) => setNullToken(event.target.value)} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)} />
            {t("import.hasHeader")}
          </label>
        </div>
        {problem ? <p className="form-error">{problem}</p> : null}
        {preview ? (
          <>
            <div className="form-section-title">{t("import.columns")}</div>
            <div className="import-mapping">
              {table.columns.map((column) => (
                <label key={column.name} className="mapping-row">
                  <span className="mono">{column.name}{column.primaryKey ? " · pk" : ""}</span>
                  <select
                    value={mapping[column.name] ?? ""}
                    aria-label={t("import.sourceOf", { column: column.name })}
                    onChange={(event) => setMapping((current) => ({ ...current, [column.name]: event.target.value === "" ? null : Number(event.target.value) }))}
                  >
                    <option value="">{isGeneratedColumn(column) || column.nullable || column.defaultValue ? t("import.skip") : t("import.skipRequired")}</option>
                    {sourceColumns.map((name, index) => <option key={index} value={index}>{name}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="form-section-title">{t("import.preview")}</div>
            <div className="import-preview">
              <table>
                <thead>
                  <tr>{mapped.map((column) => <th key={column.name}>{column.name}</th>)}</tr>
                </thead>
                <tbody>
                  {sampleRows.map((row, index) => (
                    <tr key={index}>
                      {mapped.map((column) => {
                        const cell = row[mapping[column.name] ?? -1] ?? "";
                        const isNull = cell === "" || (nullToken.trim() !== "" && cell === nullToken);
                        return <td key={column.name} className={isNull ? "null" : undefined}>{isNull ? "NULL" : cell}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : problem ? null : <p className="field-hint">{t("import.reading")}</p>}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          {progress !== null ? <span className="import-progress">{plural("import.progress", progress)}</span> : null}
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button" disabled={busy || !preview || mapped.length === 0}>
            <Upload size={14} /> {busy ? t("import.importing") : plural("import.submit", mapped.length)}
          </button>
        </div>
      </form>
    </div>
  );
}

import { engineSpec } from "../engines";
import { useState } from "react";
import { ChevronRight, Minus, Plus, X } from "lucide-react";
import { type DatabaseEngine } from "../lib/api";
import { type TableSchema } from "../lib/api";
import { columnTypeSpecs, columnTypes, createTableSql, isGeneratedType, referencingType, sizeKind, type AddedColumn, type NewColumn } from "./changes";
import { fkActions } from "./relations";
import { plural, t } from "../lib/i18n";

export function NameDialog({
  title,
  description,
  initial,
  confirmLabel,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal small-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name);
        }}
      >
        <div className="modal-topline">
          <h2>{title}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{description}</p>
        <label>
          {t("dialog.name")}
          <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setName(event.target.value)} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button" disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal small-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="modal-topline">
          <h2>{title}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{description}</p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button danger-button" disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ColumnDialog({
  engine,
  table,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  engine: DatabaseEngine;
  table: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (column: AddedColumn) => void;
}) {
  const types = columnTypeSpecs(engine);
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState(types[0]?.name ?? "text");
  const [length, setLength] = useState("");
  const [precision, setPrecision] = useState("");
  const [scale, setScale] = useState("");
  const [nullable, setNullable] = useState(true);
  const [unique, setUnique] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const spec = types.find((type) => type.name === dataType) ?? types[0];
  const generated = Boolean(spec?.generated);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal details-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name,
            dataType,
            length,
            precision,
            scale,
            nullable: generated ? false : nullable,
            unique,
            defaultValue: generated ? "" : defaultValue,
          });
        }}
      >
        <div className="modal-topline">
          <h2>{t("dialog.column.title")}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{t("dialog.column.description", { table })}</p>
        <div className="form-grid">
          <label className="span-2">
            {t("dialog.name")}
            <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="span-2">
            {t("dialog.type")}
            <select value={dataType} onChange={(event) => setDataType(event.target.value)}>
              {types.map((type) => (
                <option key={type.name} value={type.name}>{type.name}</option>
              ))}
            </select>
          </label>
          {spec?.kind === "length" ? (
            <label className="span-2">
              {t("dialog.length")}
              <input value={length} inputMode="numeric" placeholder={t("dialog.column.lengthPlaceholder")} onChange={(event) => setLength(event.target.value)} />
            </label>
          ) : null}
          {spec?.kind === "numeric" ? (
            <>
              <label>
                {t("dialog.precision")}
                <input value={precision} inputMode="numeric" placeholder={t("dialog.optional")} onChange={(event) => setPrecision(event.target.value)} />
              </label>
              <label>
                {t("dialog.scale")}
                <input value={scale} inputMode="numeric" placeholder={t("dialog.optional")} onChange={(event) => setScale(event.target.value)} />
              </label>
            </>
          ) : null}
          <label className="check-row">
            <input type="checkbox" checked={generated ? false : nullable} disabled={generated} onChange={(event) => setNullable(event.target.checked)} />
            {t("dialog.nullable")}
          </label>
          {engineSpec(engine).structure.uniqueOnAdd ? (
            <label className="check-row">
              <input type="checkbox" checked={unique} onChange={(event) => setUnique(event.target.checked)} />
              {t("dialog.unique")}
            </label>
          ) : null}
          <label className="span-2">
            {t("dialog.defaultValue")}
            <input
              value={generated ? "" : defaultValue}
              disabled={generated}
              placeholder={generated ? t("dialog.column.generatedPlaceholder") : t("dialog.column.defaultPlaceholder")}
              onChange={(event) => setDefaultValue(event.target.value)}
            />
          </label>
        </div>
        <p className="field-hint">
          {generated
            ? t("dialog.column.hintGenerated")
            : nullable
              ? t("dialog.column.hintNullable")
              : t("dialog.column.hintRequired")}
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button" disabled={busy}>{t("dialog.column.add")}</button>
        </div>
      </form>
    </div>
  );
}

/** An auto-incrementing key where the engine has one, so new tables get ids for free. */
function defaultKeyType(engine: DatabaseEngine, types: string[]): string {
  const preferred = engineSpec(engine).structure.keyType;
  return types.includes(preferred) ? preferred : (types[0] ?? "text");
}

function referenceKey(reference: NewColumn["reference"]): string {
  return reference ? [reference.schema ?? "", reference.table, reference.column].join("\u0000") : "";
}

export function TableDialog({
  engine,
  schema,
  tables,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  engine: DatabaseEngine;
  schema: string | null;
  /** Existing tables a new column can reference. */
  tables: TableSchema[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string, columns: NewColumn[]) => void;
}) {
  const types = columnTypes(engine);
  const targets = tables.filter((table) => table.kind === "table" && table.columns.length > 0);
  const chooseReference = (index: number, key: string, current: NewColumn) => {
    if (!key) {
      update(index, { reference: null });
      return;
    }
    const [refSchema, refTable, refColumn] = key.split("\u0000");
    const table = targets.find((item) => (item.schema ?? "") === refSchema && item.name === refTable);
    const column = table?.columns.find((item) => item.name === refColumn);
    if (!table || !column) return;
    const type = referencingType(engine, column.dataType);
    update(index, {
      reference: { schema: table.schema, table: table.name, column: column.name, onDelete: current.reference?.onDelete ?? "NO ACTION" },
      ...(type ? { dataType: type, size: "" } : {}),
    });
  };
  const [name, setName] = useState("");
  const [showSql, setShowSql] = useState(false);
  const blank = (patch: Partial<NewColumn>): NewColumn => ({
    name: "",
    dataType: types[0] ?? "text",
    size: "",
    defaultValue: "",
    primaryKey: false,
    required: false,
    unique: false,
    reference: null,
    ...patch,
  });
  const [columns, setColumns] = useState<NewColumn[]>([
    blank({ name: "id", dataType: defaultKeyType(engine, types), primaryKey: true, required: true }),
  ]);
  const update = (index: number, patch: Partial<NewColumn>) => {
    setColumns((current) => current.map((column, item) => (item === index ? { ...column, ...patch } : column)));
  };
  let preview: string;
  let previewOk = true;
  try {
    preview = createTableSql(schema, name.trim() || t("dialog.table.previewName"), columns, engine);
  } catch (caught) {
    preview = caught instanceof Error ? caught.message : String(caught);
    previewOk = false;
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal table-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name, columns);
        }}
      >
        <div className="modal-topline">
          <h2>{t("dialog.table.title")}</h2>
          <button type="button" className="close-button" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{schema ? t("dialog.table.inSchema", { schema }) : t("dialog.table.inDatabase")}</p>
        <label className="form-field">
          {t("dialog.name")}
          <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" placeholder={t("dialog.table.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="form-section-title">{t("dialog.columns")}</div>
        <div className="column-group">
          <div className="column-group-head">
            <span>{t("dialog.name")}</span>
            <span>{t("dialog.type")}</span>
            <span title={t("dialog.table.sizeTitle")}>{t("dialog.table.size")}</span>
            <span>{t("dialog.table.default")}</span>
            <span title={t("dialog.table.keyTitle")}>{t("dialog.table.key")}</span>
            <span title={t("dialog.table.notNullTitle")}>{t("dialog.table.notNull")}</span>
            <span title={t("dialog.table.uniqueTitle")}>{t("dialog.unique")}</span>
            <span title={t("dialog.table.referenceTitle")}>{t("dialog.reference")}</span>
            <span />
          </div>
          {columns.map((column, index) => {
            const kind = sizeKind(engine, column.dataType);
            const generated = isGeneratedType(engine, column.dataType);
            return (
              <div className="column-editor-row" key={index}>
                <input
                  value={column.name}
                  aria-label={t("dialog.table.columnName")}
                  placeholder={t("dialog.table.columnPlaceholder")}
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                <select
                  value={column.dataType}
                  aria-label={t("dialog.type")}
                  onChange={(event) => update(index, { dataType: event.target.value, size: sizeKind(engine, event.target.value) === kind ? column.size : "" })}
                >
                  {types.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  value={kind === "plain" ? "" : column.size}
                  aria-label={t("dialog.table.size")}
                  inputMode="numeric"
                  disabled={kind === "plain"}
                  placeholder={kind === "length" ? (engineSpec(engine).structure.lengthHint ?? "—") : kind === "numeric" ? "10,2" : ""}
                  onChange={(event) => update(index, { size: event.target.value })}
                />
                <input
                  value={generated ? "" : column.defaultValue}
                  aria-label={t("dialog.defaultValue")}
                  disabled={generated}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder={generated ? t("dialog.table.automatic") : "NULL"}
                  onChange={(event) => update(index, { defaultValue: event.target.value })}
                />
                <input
                  type="checkbox"
                  aria-label={t("dialog.table.primaryKey")}
                  checked={column.primaryKey}
                  onChange={(event) => update(index, { primaryKey: event.target.checked, required: event.target.checked || column.required })}
                />
                <input
                  type="checkbox"
                  aria-label={t("dialog.table.notNull")}
                  checked={column.primaryKey || column.required}
                  disabled={column.primaryKey}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                <input
                  type="checkbox"
                  aria-label={t("dialog.unique")}
                  checked={column.primaryKey || column.unique}
                  disabled={column.primaryKey}
                  onChange={(event) => update(index, { unique: event.target.checked })}
                />
                <div className={column.reference ? "reference-cell linked" : "reference-cell"}>
                  <select value={referenceKey(column.reference)} aria-label={t("dialog.reference")} onChange={(event) => chooseReference(index, event.target.value, column)}>
                    <option value="">—</option>
                    {targets.map((table) => (
                      <optgroup key={`${table.schema ?? ""}.${table.name}`} label={table.schema && table.schema !== schema ? `${table.schema}.${table.name}` : table.name}>
                        {table.columns.map((item) => (
                          <option key={item.name} value={[table.schema ?? "", table.name, item.name].join("\u0000")}>
                            {table.name}.{item.name}{item.primaryKey ? " (pk)" : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {column.reference ? (
                    <select
                      value={column.reference.onDelete}
                      aria-label={t("dialog.onDelete")}
                      title={t("dialog.table.onDeleteTitle")}
                      onChange={(event) => update(index, { reference: column.reference ? { ...column.reference, onDelete: event.target.value } : null })}
                    >
                      {fkActions.map((action) => <option key={action} value={action}>{action === "NO ACTION" ? t("dialog.table.onDeleteNothing") : t("dialog.table.onDeleteAction", { action: action.toLowerCase() })}</option>)}
                    </select>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="tiny-icon"
                  aria-label={t("dialog.table.removeColumn")}
                  disabled={columns.length === 1}
                  onClick={() => setColumns((current) => current.filter((_, item) => item !== index))}
                >
                  <Minus size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="group-actions">
          <button
            type="button"
            className="tiny-icon"
            aria-label={t("dialog.addColumn")}
            title={t("dialog.addColumn")}
            onClick={() => setColumns((current) => [...current, blank({})])}
          >
            <Plus size={14} />
          </button>
          <span>{plural("dialog.table.columnCount", columns.length)}</span>
          <button type="button" className="disclosure" aria-expanded={showSql} onClick={() => setShowSql((current) => !current)}>
            <ChevronRight size={12} className={showSql ? "open" : undefined} /> SQL
          </button>
        </div>
        {showSql ? <pre className={previewOk ? "preview-sql table-sql" : "preview-sql table-sql invalid"}>{preview}</pre> : null}
        <p className="field-hint table-hint">
          {t("dialog.table.hintBefore")}<code>0</code>, <code>{t("dialog.table.hintActive")}</code>, <code>now()</code>{t("dialog.table.hintOr")}<code>current_timestamp</code>{t("dialog.table.hintAfter")}
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="submit" className="primary-button" disabled={busy}>{t("dialog.table.create")}</button>
        </div>
      </form>
    </div>
  );
}

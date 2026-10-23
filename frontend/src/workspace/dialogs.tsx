import { useState } from "react";
import { ChevronRight, Minus, Plus, X } from "lucide-react";
import { type DatabaseEngine } from "../lib/api";
import { type TableSchema } from "../lib/api";
import { columnTypeSpecs, columnTypes, createTableSql, isGeneratedType, referencingType, sizeKind, type AddedColumn, type NewColumn } from "./changes";
import { fkActions } from "./relations";

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
          <button type="button" className="close-button" aria-label="Cerrar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{description}</p>
        <label>
          Nombre
          <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setName(event.target.value)} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
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
          <button type="button" className="close-button" aria-label="Cerrar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{description}</p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
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
          <h2>Nueva columna</h2>
          <button type="button" className="close-button" aria-label="Cerrar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">Se agrega al final de {table}.</p>
        <div className="form-grid">
          <label className="span-2">
            Nombre
            <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="span-2">
            Tipo
            <select value={dataType} onChange={(event) => setDataType(event.target.value)}>
              {types.map((type) => (
                <option key={type.name} value={type.name}>{type.name}</option>
              ))}
            </select>
          </label>
          {spec?.kind === "length" ? (
            <label className="span-2">
              Longitud
              <input value={length} inputMode="numeric" placeholder="opcional, por ejemplo 255" onChange={(event) => setLength(event.target.value)} />
            </label>
          ) : null}
          {spec?.kind === "numeric" ? (
            <>
              <label>
                Precisión
                <input value={precision} inputMode="numeric" placeholder="opcional" onChange={(event) => setPrecision(event.target.value)} />
              </label>
              <label>
                Escala
                <input value={scale} inputMode="numeric" placeholder="opcional" onChange={(event) => setScale(event.target.value)} />
              </label>
            </>
          ) : null}
          <label className="check-row">
            <input type="checkbox" checked={generated ? false : nullable} disabled={generated} onChange={(event) => setNullable(event.target.checked)} />
            Acepta NULL
          </label>
          {engine !== "sqlite" ? (
            <label className="check-row">
              <input type="checkbox" checked={unique} onChange={(event) => setUnique(event.target.checked)} />
              Única
            </label>
          ) : null}
          <label className="span-2">
            Valor predeterminado
            <input
              value={generated ? "" : defaultValue}
              disabled={generated}
              placeholder={generated ? "lo asigna la base" : "0, activo, now()"}
              onChange={(event) => setDefaultValue(event.target.value)}
            />
          </label>
        </div>
        <p className="field-hint">
          {generated
            ? "Este tipo genera el valor solo. No hace falta NULL ni predeterminado."
            : nullable
              ? "Si lo dejas vacío, las filas que ya existen quedan en NULL."
              : "Como no acepta NULL, el predeterminado rellena las filas que ya existen."}
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={busy}>Agregar</button>
        </div>
      </form>
    </div>
  );
}

/** An auto-incrementing key where the engine has one, so new tables get ids for free. */
function defaultKeyType(engine: DatabaseEngine, types: string[]): string {
  const preferred = engine === "postgres" ? "serial" : engine === "mysql" ? "serial" : "INTEGER";
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
    preview = createTableSql(schema, name.trim() || "nueva_tabla", columns, engine);
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
          <h2>Nueva tabla</h2>
          <button type="button" className="close-button" aria-label="Cerrar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-description">{schema ? `Se crea en el esquema ${schema}.` : "Se crea en la base abierta."}</p>
        <label className="form-field">
          Nombre
          <input value={name} autoFocus autoCorrect="off" autoCapitalize="off" placeholder="clientes" onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="form-section-title">Columnas</div>
        <div className="column-group">
          <div className="column-group-head">
            <span>Nombre</span>
            <span>Tipo</span>
            <span title="Longitud, o precisión y escala: 255 o 10,2">Tamaño</span>
            <span>Predeterminado</span>
            <span title="Forma parte de la clave primaria">Clave</span>
            <span title="NOT NULL: no acepta valores vacíos">No nulo</span>
            <span title="UNIQUE: no admite valores repetidos">Única</span>
            <span title="Clave foránea: la columna apunta a otra tabla">Referencia</span>
            <span />
          </div>
          {columns.map((column, index) => {
            const kind = sizeKind(engine, column.dataType);
            const generated = isGeneratedType(engine, column.dataType);
            return (
              <div className="column-editor-row" key={index}>
                <input
                  value={column.name}
                  aria-label="Nombre de columna"
                  placeholder="columna"
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                <select
                  value={column.dataType}
                  aria-label="Tipo"
                  onChange={(event) => update(index, { dataType: event.target.value, size: sizeKind(engine, event.target.value) === kind ? column.size : "" })}
                >
                  {types.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  value={kind === "plain" ? "" : column.size}
                  aria-label="Tamaño"
                  inputMode="numeric"
                  disabled={kind === "plain"}
                  placeholder={kind === "length" ? (engine === "mysql" ? "255" : "—") : kind === "numeric" ? "10,2" : ""}
                  onChange={(event) => update(index, { size: event.target.value })}
                />
                <input
                  value={generated ? "" : column.defaultValue}
                  aria-label="Valor predeterminado"
                  disabled={generated}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder={generated ? "automático" : "NULL"}
                  onChange={(event) => update(index, { defaultValue: event.target.value })}
                />
                <input
                  type="checkbox"
                  aria-label="Clave primaria"
                  checked={column.primaryKey}
                  onChange={(event) => update(index, { primaryKey: event.target.checked, required: event.target.checked || column.required })}
                />
                <input
                  type="checkbox"
                  aria-label="No nulo"
                  checked={column.primaryKey || column.required}
                  disabled={column.primaryKey}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                <input
                  type="checkbox"
                  aria-label="Única"
                  checked={column.primaryKey || column.unique}
                  disabled={column.primaryKey}
                  onChange={(event) => update(index, { unique: event.target.checked })}
                />
                <div className={column.reference ? "reference-cell linked" : "reference-cell"}>
                  <select value={referenceKey(column.reference)} aria-label="Referencia" onChange={(event) => chooseReference(index, event.target.value, column)}>
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
                      aria-label="Al borrar"
                      title="Qué pasa con esta fila cuando se borra la referenciada"
                      onChange={(event) => update(index, { reference: column.reference ? { ...column.reference, onDelete: event.target.value } : null })}
                    >
                      {fkActions.map((action) => <option key={action} value={action}>{action === "NO ACTION" ? "al borrar: nada" : `al borrar: ${action.toLowerCase()}`}</option>)}
                    </select>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="tiny-icon"
                  aria-label="Quitar columna"
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
            aria-label="Agregar columna"
            title="Agregar columna"
            onClick={() => setColumns((current) => [...current, blank({})])}
          >
            <Plus size={14} />
          </button>
          <span>{columns.length === 1 ? "1 columna" : `${columns.length} columnas`}</span>
          <button type="button" className="disclosure" aria-expanded={showSql} onClick={() => setShowSql((current) => !current)}>
            <ChevronRight size={12} className={showSql ? "open" : undefined} /> SQL
          </button>
        </div>
        {showSql ? <pre className={previewOk ? "preview-sql table-sql" : "preview-sql table-sql invalid"}>{preview}</pre> : null}
        <p className="field-hint table-hint">
          En el predeterminado escribe el valor tal cual: <code>0</code>, <code>activo</code>, <code>now()</code> o <code>current_timestamp</code>. El texto se pone entre comillas solo.
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={busy}>Crear</button>
        </div>
      </form>
    </div>
  );
}

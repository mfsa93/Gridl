import {
  Check,
  ChevronLeft, ChevronRight,
  Command,
  Eye,
  EyeOff,
  Folder,
  Layers3,
  LockKeyhole,
  Plus,
  Search,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { errorMessage, type BrowseKind, type ConnectionCatalog, type ConnectionConfig, type DatabaseEngine, type TestResult, type TlsMode } from "../lib/api";
import { environmentLabel } from "../lib/environments";
import { SafetyFields } from "./SafetyFields";
import { blankDraft, draftFromProfile, subtitle, type Draft } from "./draft";

export type HomeCommand = { nonce: number; kind: "new-connection" | "new-group" };

type Phase =
  | { kind: "list" }
  | { kind: "choose"; group: string; draft: Draft | null }
  | { kind: "form"; draft: Draft }
  | { kind: "group" };

type EngineOption = {
  id: DatabaseEngine;
  short: string;
  name: string;
  color: string;
  description: string;
};

const ENGINES: EngineOption[] = [
  { id: "postgres", short: "Pg", name: "PostgreSQL", color: "#3b82f6", description: "Potente y flexible" },
  { id: "mysql", short: "My", name: "MySQL / MariaDB", color: "#f59e0b", description: "El clásico de la web" },
  { id: "sqlite", short: "Sl", name: "SQLite", color: "#8b5cf6", description: "Local y ligero" },
];

type Props = {
  catalog: ConnectionCatalog;
  busy: boolean;
  error: string | null;
  onCreateGroup: (name: string) => Promise<boolean>;
  onDeleteGroup: (name: string) => Promise<void>;
  onDeleteConnection: (id: string) => Promise<void>;
  onOpen: (profile: ConnectionConfig) => Promise<boolean>;
  /** Opens the connection in a window of its own. */
  onOpenWindow: (profile: ConnectionConfig) => void;
  onSave: (draft: Draft, openAfter: boolean) => Promise<boolean>;
  onBrowse: (kind: BrowseKind) => Promise<string | null>;
  onTest: (draft: Draft) => Promise<TestResult>;
  pendingCommand: HomeCommand | null;
};

export function ConnectionHome({
  catalog,
  busy,
  error,
  onCreateGroup,
  onDeleteGroup,
  onDeleteConnection,
  onOpen,
  onOpenWindow,
  onSave,
  onBrowse,
  onTest,
  pendingCommand,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("all");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [appliedNonce, setAppliedNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (pendingCommand && pendingCommand.nonce !== appliedNonce) {
    setAppliedNonce(pendingCommand.nonce);
    setPhase(pendingCommand.kind === "new-connection" ? { kind: "choose", group: "", draft: null } : { kind: "group" });
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.profiles.filter((profile) => {
      if (space !== "all" && profile.group !== space) return false;
      if (!needle) return true;
      return [profile.name, profile.database, profile.host ?? "", profile.engine].join(" ").toLowerCase().includes(needle);
    });
  }, [catalog.profiles, query, space]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  };

  const openMenu = (event: MouseEvent, items: RowMenu["items"]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div className="app-shell">
      <main className="connection-home">
        <section className="connection-toolbar" data-tauri-drag-region>
          <div className="search-wrap">
            <Search size={17} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar conexión..."
            />
            <kbd>
              <Command size={11} /> K
            </kbd>
          </div>
          <button type="button" className="secondary-button" onClick={() => setPhase({ kind: "group" })}>
            <Folder size={16} /> Nuevo grupo
          </button>
          <button type="button" className="primary-button" onClick={() => setPhase({ kind: "choose", group: space === "all" ? "" : space, draft: null })}>
            <Plus size={17} /> Nueva conexión
          </button>
        </section>

        <section className="workspace-grid">
          <aside className="sidebar-card">
            <div className="sidebar-heading">
              <span>Espacios</span>
            </div>
            <button type="button" className={space === "all" ? "nav-row active" : "nav-row"} onClick={() => setSpace("all")}>
              <Layers3 size={16} /> Todas las conexiones <span>{catalog.profiles.length}</span>
            </button>
            <div className="sidebar-heading group-heading">
              <span>Grupos</span>
              <button type="button" className="tiny-icon" aria-label="Nuevo grupo" onClick={() => setPhase({ kind: "group" })}>
                <Plus size={15} />
              </button>
            </div>
            {catalog.groups.map((group) => {
              const count = catalog.profiles.filter((profile) => profile.group === group).length;
              return (
                <div key={group} className="nav-wrap" onContextMenu={(event) => openMenu(event, groupActions(group, onDeleteGroup))}>
                  <button type="button" className={space === group ? "nav-row active" : "nav-row"} onClick={() => setSpace(group)}>
                    <Folder size={16} /> {group} <span>{count}</span>
                  </button>
                </div>
              );
            })}
            <div className="sidebar-footer">
              <ShieldCheck size={14} /> Las contraseñas se guardan en el llavero del sistema.
            </div>
          </aside>

          <section className="connections-panel">
            <div className="panel-heading">
              <div>
                <h2>{space === "all" ? "Todas las conexiones" : space}</h2>
                <p>
                  {filtered.length} {filtered.length === 1 ? "conexión" : "conexiones"}
                </p>
              </div>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="connection-list">
              {filtered.map((profile) => {
                const engine = ENGINES.find((item) => item.id === profile.engine);
                return (
                  <div
                    key={profile.id}
                    className="connection-card-wrap"
                    onContextMenu={(event) =>
                      openMenu(event, [
                        { label: "Conectar", run: () => void onOpen(profile) },
                        { label: "Abrir en ventana nueva", run: () => onOpenWindow(profile) },
                        { label: "Editar…", run: () => setPhase({ kind: "form", draft: draftFromProfile(profile) }) },
                        {
                          label: "Duplicar…",
                          run: () =>
                            setPhase({
                              kind: "form",
                              draft: { ...draftFromProfile(profile), id: crypto.randomUUID(), name: `${profile.name} (copia)`, credentialAccount: null, sshCredentialAccount: null },
                            }),
                        },
                        {
                          label: "Quitar",
                          run: () => {
                            if (window.confirm(`¿Quitar “${profile.name}”?`)) void onDeleteConnection(profile.id);
                          },
                        },
                      ])
                    }
                  >
                    <button
                      type="button"
                      className="connection-card"
                      disabled={busy}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) onOpenWindow(profile);
                        else void onOpen(profile);
                      }}
                    >
                      <div className="db-icon" style={{ background: engine?.color ?? "#64748b" }}>
                        {engine?.short ?? "DB"}
                      </div>
                      <div className="connection-main">
                        <div className="connection-name">{profile.name}</div>
                        <div className="connection-meta">
                          <Server size={13} /> {subtitle(profile)}
                        </div>
                      </div>
                      {profile.safety && profile.safety.environment !== "local" ? (
                        <div className={`env-pill env-${profile.safety.environment}`}>{environmentLabel(profile.safety.environment)}</div>
                      ) : null}
                      <div className="connection-type">{engine?.name ?? profile.engine}</div>
                      <div className="connection-last">
                        Guardada
                        <span>{profile.group ?? "Sin grupo"}</span>
                      </div>
                      <ChevronRight className="chevron" size={18} />
                    </button>
                  </div>
                );
              })}
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <Search size={28} />
                  <strong>No hay conexiones aquí</strong>
                  <span>Crea una o prueba con otro nombre.</span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="add-connection-row"
              onClick={() => setPhase({ kind: "choose", group: space === "all" ? "" : space, draft: null })}
            >
              <Plus size={18} />
              <span>{space === "all" ? "Agregar una nueva conexión" : `Agregar conexión en ${space}`}</span>
              <kbd>⌘ N</kbd>
            </button>
          </section>
        </section>

        <footer className="home-footer">
          <span>Versión 0.1.0</span>
        </footer>
      </main>

      {phase.kind === "choose" || phase.kind === "form" ? (
        <ConnectionModal
          phase={phase}
          groups={catalog.groups}
          busy={busy}
          error={error}
          onBrowse={onBrowse}
          onTest={onTest}
          onClose={() => setPhase({ kind: "list" })}
          onChoose={(engine) =>
            setPhase({
              kind: "form",
              draft:
                phase.kind === "choose" && phase.draft
                  ? { ...phase.draft, engine }
                  : { ...blankDraft(engine), group: phase.kind === "choose" ? phase.group : "" },
            })
          }
          onBack={() =>
            setPhase({
              kind: "choose",
              group: phase.kind === "form" ? phase.draft.group : "",
              draft: phase.kind === "form" ? phase.draft : null,
            })
          }
          onChange={(draft) => setPhase({ kind: "form", draft })}
          onSave={async (draft, openAfter) => {
            const ok = await onSave(draft, openAfter);
            if (ok && !openAfter) {
              setPhase({ kind: "list" });
              showNotice("Conexión guardada");
            }
          }}
        />
      ) : null}
      {phase.kind === "group" ? (
        <GroupModal
          busy={busy}
          onClose={() => setPhase({ kind: "list" })}
          onCreate={async (name) => {
            const ok = await onCreateGroup(name);
            if (!ok) return;
            setPhase({ kind: "list" });
            setSpace(name);
            showNotice("Grupo creado");
          }}
        />
      ) : null}
      {menu ? <RowMenuBox menu={menu} onClose={() => setMenu(null)} /> : null}
      {notice ? (
        <div className="toast">
          <Check size={16} /> {notice}
        </div>
      ) : null}
    </div>
  );
}

function groupActions(name: string, onDeleteGroup: (name: string) => Promise<void>): RowMenu["items"] {
  return [
    {
      label: "Quitar grupo",
      run: () => {
        if (window.confirm(`¿Quitar el grupo “${name}”? Las conexiones se quedan sin grupo.`)) {
          void onDeleteGroup(name);
        }
      },
    },
  ];
}

function ConnectionModal({
  phase,
  groups,
  busy,
  error,
  onBrowse,
  onTest,
  onClose,
  onChoose,
  onBack,
  onChange,
  onSave,
}: {
  phase: Extract<Phase, { kind: "choose" }> | Extract<Phase, { kind: "form" }>;
  groups: string[];
  busy: boolean;
  error: string | null;
  onBrowse: (kind: BrowseKind) => Promise<string | null>;
  onTest: (draft: Draft) => Promise<TestResult>;
  onClose: () => void;
  onChoose: (engine: DatabaseEngine) => void;
  onBack: () => void;
  onChange: (draft: Draft) => void;
  onSave: (draft: Draft, openAfter: boolean) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<DatabaseEngine>(phase.kind === "form" ? phase.draft.engine : "postgres");
  const [showPassword, setShowPassword] = useState(false);
  const engines = ENGINES.filter((engine) => engine.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const draft = phase.kind === "form" ? phase.draft : null;
  const engine = ENGINES.find((item) => item.id === (draft?.engine ?? selected));

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={draft ? "modal details-modal" : "modal"}>
        <div className="modal-topline">
          <div>
            <span className="modal-kicker">Nueva conexión</span>
            <h2>{draft ? `Conectar a ${engine?.name}` : "Elige tu motor"}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        {draft ? (
          <DetailsStep
            draft={draft}
            groups={groups}
            busy={busy}
            error={error}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword((current) => !current)}
            onBack={onBack}
            onChange={onChange}
            onBrowse={onBrowse}
            onTest={onTest}
            onClose={onClose}
            onSave={onSave}
          />
        ) : (
          <>
            <p className="modal-description">Selecciona el motor que quieres añadir a tu espacio de trabajo.</p>
            <div className="modal-search">
              <Search size={16} />
              <input value={filter} placeholder="Buscar motor de base de datos..." onChange={(event) => setFilter(event.target.value)} />
            </div>
            <div className="database-options">
              {engines.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selected === item.id ? "database-option selected" : "database-option"}
                  onClick={() => setSelected(item.id)}
                  onDoubleClick={() => onChoose(item.id)}
                >
                  <span className="option-icon" style={{ background: item.color }}>
                    {item.short}
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  {selected === item.id ? <Check className="selected-check" size={17} /> : null}
                </button>
              ))}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={onClose}>
                Cancelar
              </button>
              <button type="button" className="primary-button" onClick={() => onChoose(selected)}>
                Continuar <ChevronRight size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const TLS_MODES: { id: TlsMode; label: string }[] = [
  { id: "prefer", label: "Preferir" },
  { id: "disable", label: "Desactivar" },
  { id: "require", label: "Exigir" },
  { id: "verify-ca", label: "Verificar CA" },
  { id: "verify-full", label: "Verificar host" },
];

function DetailsStep({
  draft,
  groups,
  busy,
  error,
  showPassword,
  onTogglePassword,
  onBack,
  onChange,
  onBrowse,
  onTest,
  onClose,
  onSave,
}: {
  draft: Draft;
  groups: string[];
  busy: boolean;
  error: string | null;
  showPassword: boolean;
  onTogglePassword: () => void;
  onBack: () => void;
  onChange: (draft: Draft) => void;
  onBrowse: (kind: BrowseKind) => Promise<string | null>;
  onTest: (draft: Draft) => Promise<TestResult>;
  onClose: () => void;
  onSave: (draft: Draft, openAfter: boolean) => Promise<void>;
}) {
  const [section, setSection] = useState<"general" | "ssl" | "tunnel">("general");
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);
  const patch = (partial: Partial<Draft>) => onChange({ ...draft, ...partial });
  const pick = (kind: BrowseKind, apply: (path: string) => void) => {
    void onBrowse(kind).then((selected) => {
      if (selected) apply(selected);
    });
  };
  const runTest = () => {
    setTesting(true);
    setTestNote(null);
    void onTest(draft)
      .then((result) => {
        if (result.hostFingerprint) patch({ sshHostFingerprint: result.hostFingerprint, trustSshHost: true });
        setTestNote({ ok: true, text: `${result.message} · ${result.durationMs} ms` });
      })
      .catch((caught: unknown) => setTestNote({ ok: false, text: errorMessage(caught) }))
      .finally(() => setTesting(false));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft, true);
      }}
    >
      <button type="button" className="back-link" onClick={onBack}>
        <ChevronLeft size={14} /> Cambiar motor
      </button>
      <div className="security-tabs">
        <button type="button" className={section === "general" ? "active" : ""} onClick={() => setSection("general")}>
          General
        </button>
        {draft.engine !== "sqlite" ? (
          <>
            <button type="button" className={section === "ssl" ? "active" : ""} onClick={() => setSection("ssl")}>
              SSL
            </button>
            <button type="button" className={section === "tunnel" ? "active" : ""} onClick={() => setSection("tunnel")}>
              Túnel
            </button>
          </>
        ) : null}
      </div>
      {section === "general" ? (
        <>
          <div className="form-grid">
            <label>
              Nombre de la conexión
              <input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
            </label>
            <label>
              Grupo
              <input list="connection-groups" value={draft.group} placeholder="Sin grupo" onChange={(event) => patch({ group: event.target.value })} />
              <datalist id="connection-groups">
                {groups.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </label>
            {draft.engine === "sqlite" ? (
              <label className="span-2">
                Archivo
                <div className="password-input">
                  <input value={draft.database} placeholder="/ruta/a/datos.sqlite" onChange={(event) => patch({ database: event.target.value })} />
                  <button type="button" aria-label="Elegir archivo" onClick={() => pick("sqlite", (database) => patch({ database }))}>
                    <Folder size={16} />
                  </button>
                </div>
              </label>
            ) : (
              <>
                <label>
                  Host
                  <input value={draft.host} onChange={(event) => patch({ host: event.target.value })} />
                </label>
                <label>
                  Puerto
                  <input value={draft.port} onChange={(event) => patch({ port: event.target.value })} />
                </label>
                <label>
                  Base de datos
                  <input value={draft.database} onChange={(event) => patch({ database: event.target.value })} />
                </label>
                <label>
                  Usuario
                  <input value={draft.username} onChange={(event) => patch({ username: event.target.value })} />
                </label>
                <label className="span-2">
                  Contraseña
                  <div className="password-input">
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="off"
                      value={draft.password}
                      placeholder={draft.credentialAccount ? "Guardada en el llavero" : ""}
                      onChange={(event) => patch({ password: event.target.value })}
                    />
                    <button type="button" onClick={onTogglePassword} aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>
              </>
            )}
          </div>
          {draft.engine !== "sqlite" ? (
            <label className="check-row">
              <input type="checkbox" checked={draft.rememberPassword} onChange={(event) => patch({ rememberPassword: event.target.checked })} />
              Guardar contraseña en el llavero
            </label>
          ) : (
            <label className="check-row">
              <input type="checkbox" checked={draft.createIfMissing} onChange={(event) => patch({ createIfMissing: event.target.checked })} />
              Crear el archivo si no existe
            </label>
          )}
          <div className="secure-note">
            <LockKeyhole size={15} />
            <span>La contraseña no se guarda en el archivo de conexiones.</span>
          </div>
          <SafetyFields safety={draft.safety} onChange={(safety) => patch({ safety })} />
        </>
      ) : null}
      {draft.engine !== "sqlite" && section === "ssl" ? (
        <div className="form-grid">
          <label className="span-2">
            Modo SSL
            <select value={draft.tlsMode} onChange={(event) => patch({ tlsMode: event.target.value as TlsMode })}>
              {TLS_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            Certificado CA
            <div className="password-input">
              <input value={draft.tlsRootCert} placeholder="ca.crt" onChange={(event) => patch({ tlsRootCert: event.target.value })} />
              <button type="button" aria-label="Elegir certificado" onClick={() => pick("certificate", (tlsRootCert) => patch({ tlsRootCert }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          <label className="span-2">
            Certificado cliente
            <div className="password-input">
              <input value={draft.tlsClientCert} placeholder="client.crt" onChange={(event) => patch({ tlsClientCert: event.target.value })} />
              <button type="button" aria-label="Elegir certificado cliente" onClick={() => pick("certificate", (tlsClientCert) => patch({ tlsClientCert }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          <label className="span-2">
            Llave cliente
            <div className="password-input">
              <input value={draft.tlsClientKey} placeholder="client.key" onChange={(event) => patch({ tlsClientKey: event.target.value })} />
              <button type="button" aria-label="Elegir llave" onClick={() => pick("key", (tlsClientKey) => patch({ tlsClientKey }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          {draft.sshEnabled && draft.tlsMode === "verify-full" ? (
            <p className="field-hint span-2">Con túnel, verificar host comprueba 127.0.0.1. Usa Verificar CA si el certificado es del servidor real.</p>
          ) : null}
        </div>
      ) : null}
      {draft.engine !== "sqlite" && section === "tunnel" ? (
        <>
          <label className="check-row">
            <input type="checkbox" checked={draft.sshEnabled} onChange={(event) => patch({ sshEnabled: event.target.checked })} />
            Conectar a través de un túnel SSH
          </label>
          {draft.sshEnabled ? (
            <div className="form-grid">
              <label>
                Servidor SSH
                <input value={draft.sshHost} placeholder="bastion.empresa.com" onChange={(event) => patch({ sshHost: event.target.value })} />
              </label>
              <label>
                Puerto
                <input value={draft.sshPort} onChange={(event) => patch({ sshPort: event.target.value })} />
              </label>
              <label>
                Usuario
                <input value={draft.sshUsername} onChange={(event) => patch({ sshUsername: event.target.value })} />
              </label>
              <label>
                Autenticación
                <select value={draft.sshAuth} onChange={(event) => patch({ sshAuth: event.target.value === "password" ? "password" : "key" })}>
                  <option value="key">Llave privada</option>
                  <option value="password">Contraseña</option>
                </select>
              </label>
              {draft.sshAuth === "key" ? (
                <label className="span-2">
                  Llave privada
                  <div className="password-input">
                    <input value={draft.sshPrivateKey} placeholder="~/.ssh/id_ed25519" onChange={(event) => patch({ sshPrivateKey: event.target.value })} />
                    <button type="button" aria-label="Elegir llave" onClick={() => pick("key", (sshPrivateKey) => patch({ sshPrivateKey }))}>
                      <Folder size={16} />
                    </button>
                  </div>
                </label>
              ) : null}
              <label className="span-2">
                {draft.sshAuth === "key" ? "Frase de la llave" : "Contraseña SSH"}
                <input
                  type="password"
                  autoComplete="off"
                  value={draft.sshSecret}
                  placeholder={draft.sshCredentialAccount ? "Guardada en el llavero" : ""}
                  onChange={(event) => patch({ sshSecret: event.target.value })}
                />
              </label>
              <label className="check-row span-2">
                <input type="checkbox" checked={draft.rememberSshSecret} onChange={(event) => patch({ rememberSshSecret: event.target.checked })} />
                Guardar en el llavero
              </label>
              {draft.sshHostFingerprint ? (
                <p className="field-hint span-2">
                  Clave del servidor: {draft.sshHostFingerprint}{" "}
                  <button type="button" className="text-button" onClick={() => patch({ sshHostFingerprint: "", trustSshHost: false })}>
                    Olvidar
                  </button>
                </p>
              ) : (
                <label className="check-row span-2">
                  <input type="checkbox" checked={draft.trustSshHost} onChange={(event) => patch({ trustSshHost: event.target.checked })} />
                  Confiar en la clave de este servidor
                </label>
              )}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {testNote ? <p className={testNote.ok ? "test-note ok" : "test-note bad"}>{testNote.text}</p> : null}
      <div className="modal-footer">
        <button type="button" className="secondary-button test-button" disabled={busy || testing} onClick={runTest}>
          {testing ? "Probando…" : "Probar"}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void onSave(draft, false)}>
          Guardar
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          <Check size={16} /> Conectar
        </button>
      </div>
    </form>
  );
}

function GroupModal({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="modal small-modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void onCreate(name.trim());
        }}
      >
        <div className="modal-topline">
          <div>
            <span className="modal-kicker">Organización</span>
            <h2>Nuevo grupo</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="modal-description">Agrupa tus conexiones para encontrarlas más rápido.</p>
        <label>
          Nombre del grupo
          <input autoFocus value={name} placeholder="Ej. Trabajo" onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
            Crear grupo
          </button>
        </div>
      </form>
    </div>
  );
}

type RowMenu = { x: number; y: number; items: { label: string; run: () => void }[] };

function RowMenuBox({ menu, onClose }: { menu: RowMenu; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClose);
    };
  }, [onClose]);

  return (
    <div className="tree-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

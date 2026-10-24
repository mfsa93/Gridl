import {
  Check,
  ChevronLeft, ChevronRight,
  Command,
  Eye,
  EyeOff,
  Folder,
  FolderSync,
  Layers3,
  LockKeyhole,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Unlink,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ConnectingStatus, type ConnectingState } from "./ConnectingStatus";
import { errorMessage, type BrowseKind, type ConnectionCatalog, type ConnectionConfig, type DatabaseEngine, type TeamState, type TestResult, type TlsMode } from "../lib/api";
import { environmentLabel } from "../lib/environments";
import { SafetyFields } from "./SafetyFields";
import { blankDraft, draftFromProfile, subtitle, type Draft } from "./draft";
import { ENGINES } from "./engines";
import { plural, t } from "../lib/i18n";

export type HomeCommand = { nonce: number; kind: "new-connection" | "new-group" };

type Phase =
  | { kind: "list" }
  | { kind: "choose"; group: string; draft: Draft | null }
  | { kind: "form"; draft: Draft }
  | { kind: "group" };


type Props = {
  catalog: ConnectionCatalog;
  busy: boolean;
  error: string | null;
  /** The connection being opened in this window, shown on its card. */
  connecting: ConnectingState | null;
  onCancelConnect: () => void;
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
  /** The team space, when a team folder is linked. */
  team: TeamState;
  onLinkTeam: () => void;
  onUnlinkTeam: () => void;
  onShare: (profile: ConnectionConfig) => void;
  onUnshare: (profile: ConnectionConfig) => void;
};

/** The sidebar space that lists the team's connections. */
const teamSpace = "\u0000team";

export function ConnectionHome({
  catalog,
  busy,
  error,
  connecting,
  onCancelConnect,
  onCreateGroup,
  onDeleteGroup,
  onDeleteConnection,
  onOpen,
  onOpenWindow,
  onSave,
  onBrowse,
  onTest,
  pendingCommand,
  team,
  onLinkTeam,
  onUnlinkTeam,
  onShare,
  onUnshare,
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

  const teamIds = useMemo(() => new Set(team.connections.map((profile) => profile.id)), [team.connections]);
  // Team connections not saved here yet show alongside, and open their form to add a password.
  const teamOnly = useMemo(() => team.connections.filter((profile) => !catalog.profiles.some((local) => local.id === profile.id)), [catalog.profiles, team.connections]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...catalog.profiles, ...teamOnly].filter((profile) => {
      if (space === teamSpace ? !teamIds.has(profile.id) : space !== "all" && profile.group !== space) return false;
      if (!needle) return true;
      return [profile.name, profile.database, profile.host ?? "", profile.engine].join(" ").toLowerCase().includes(needle);
    });
  }, [catalog.profiles, query, space, teamIds, teamOnly]);

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
              placeholder={t("home.search")}
            />
            <kbd>
              <Command size={11} /> K
            </kbd>
          </div>
          <button type="button" className="secondary-button" onClick={() => setPhase({ kind: "group" })}>
            <Folder size={16} /> {t("home.newGroup")}
          </button>
          <button type="button" className="primary-button" onClick={() => setPhase({ kind: "choose", group: space === "all" ? "" : space, draft: null })}>
            <Plus size={17} /> {t("home.newConnection")}
          </button>
        </section>

        <section className="workspace-grid">
          <aside className="sidebar-card">
            <div className="sidebar-heading">
              <span>{t("home.spaces")}</span>
            </div>
            <button type="button" className={space === "all" ? "nav-row active" : "nav-row"} onClick={() => setSpace("all")}>
              <Layers3 size={16} /> {t("home.allConnections")} <span>{catalog.profiles.length + teamOnly.length}</span>
            </button>
            <div className="sidebar-heading group-heading">
              <span>{t("home.groups")}</span>
              <button type="button" className="tiny-icon" aria-label={t("home.newGroup")} onClick={() => setPhase({ kind: "group" })}>
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
            <div className="sidebar-heading group-heading">
              <span>{t("home.team.heading")}</span>
              {team.folder ? (
                <button type="button" className="tiny-icon" aria-label={t("home.team.unlink")} title={t("home.team.unlinkTitle", { folder: team.folder })} onClick={onUnlinkTeam}>
                  <Unlink size={14} />
                </button>
              ) : null}
            </div>
            {team.folder ? (
              <button type="button" className={space === teamSpace ? "nav-row active" : "nav-row"} title={team.folder} onClick={() => setSpace(teamSpace)}>
                <Users size={16} /> {team.folder.split("/").filter(Boolean).pop() ?? t("home.team.heading")} <span>{team.connections.length}</span>
              </button>
            ) : (
              <button type="button" className="nav-row team-link" title={t("home.team.linkTitle")} onClick={onLinkTeam}>
                <FolderSync size={16} /> {t("home.team.link")}
              </button>
            )}
            {team.error ? <p className="team-error">{team.error}</p> : null}
            <div className="sidebar-footer">
              <ShieldCheck size={14} /> {t("home.keychainNote")}
            </div>
          </aside>

          <section className="connections-panel">
            <div className="panel-heading">
              <div>
                <h2>{space === "all" ? t("home.allConnections") : space === teamSpace ? t("home.team.heading") : space}</h2>
                <p>{plural("home.connectionCount", filtered.length)}</p>
              </div>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="connection-list">
              {filtered.map((profile) => {
                const engine = ENGINES.find((item) => item.id === profile.engine);
                const opening = connecting?.id === profile.id ? connecting : null;
                return (
                  <div
                    key={profile.id}
                    className={opening ? "connection-card-wrap opening" : "connection-card-wrap"}
                    onContextMenu={(event) =>
                      openMenu(event, [
                        { label: t("home.menu.connect"), run: () => void onOpen(profile) },
                        { label: t("home.menu.openWindow"), run: () => onOpenWindow(profile) },
                        ...(team.folder
                          ? [teamIds.has(profile.id)
                              ? { label: t("home.team.unshare"), run: () => onUnshare(profile) }
                              : { label: t("home.team.share"), run: () => onShare(profile) }]
                          : []),
                        { label: t("home.menu.edit"), run: () => setPhase({ kind: "form", draft: draftFromProfile(profile) }) },
                        {
                          label: t("home.menu.duplicate"),
                          run: () =>
                            setPhase({
                              kind: "form",
                              draft: { ...draftFromProfile(profile), id: crypto.randomUUID(), name: t("home.copyName", { name: profile.name }), credentialAccount: null, sshCredentialAccount: null },
                            }),
                        },
                        {
                          label: t("home.menu.remove"),
                          run: () => {
                            if (window.confirm(t("home.confirmRemove", { name: profile.name }))) void onDeleteConnection(profile.id);
                          },
                        },
                      ])
                    }
                  >
                    <button
                      type="button"
                      className="connection-card"
                      disabled={busy || Boolean(opening)}
                      aria-busy={Boolean(opening)}
                      onClick={(event) => {
                        if (teamOnly.includes(profile)) {
                          // First use on this Mac: the form asks for the password, kept in this keychain.
                          setPhase({ kind: "form", draft: draftFromProfile(profile) });
                          setNotice(t("home.team.firstUse", { name: profile.name }));
                        } else if (event.metaKey || event.ctrlKey) onOpenWindow(profile);
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
                      {teamIds.has(profile.id) ? (
                        <div className="team-pill" title={team.folder ?? undefined}>
                          <Users size={12} /> {teamOnly.includes(profile) ? t("home.team.notHere") : t("home.team.badge")}
                        </div>
                      ) : null}
                      <div className="connection-last">
                        {teamOnly.includes(profile) ? t("home.team.fromTeam") : t("home.saved")}
                        <span>{profile.group ?? t("home.noGroup")}</span>
                      </div>
                      <ChevronRight className="chevron" size={18} />
                    </button>
                    {opening ? <ConnectingStatus state={opening} onCancel={onCancelConnect} /> : null}
                  </div>
                );
              })}
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <Search size={28} />
                  <strong>{t("home.empty.title")}</strong>
                  <span>{t("home.empty.body")}</span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="add-connection-row"
              onClick={() => setPhase({ kind: "choose", group: space === "all" ? "" : space, draft: null })}
            >
              <Plus size={18} />
              <span>{space === "all" ? t("home.addConnection") : t("home.addConnectionIn", { group: space })}</span>
              <kbd>⌘ N</kbd>
            </button>
          </section>
        </section>

        <footer className="home-footer">
          <span>{t("home.version", { version: "0.1.0" })}</span>
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
              showNotice(t("home.notice.saved"));
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
            showNotice(t("home.notice.groupCreated"));
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
      label: t("home.menu.removeGroup"),
      run: () => {
        if (window.confirm(t("home.confirmRemoveGroup", { name }))) {
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
            <span className="modal-kicker">{t("home.newConnection")}</span>
            <h2>{draft ? t("home.connectTo", { engine: engine?.name ?? "" }) : t("home.chooseEngine")}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label={t("home.close")}>
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
            <p className="modal-description">{t("home.chooseEngine.description")}</p>
            <div className="modal-search">
              <Search size={16} />
              <input value={filter} placeholder={t("home.searchEngine")} onChange={(event) => setFilter(event.target.value)} />
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
                {t("home.cancel")}
              </button>
              <button type="button" className="primary-button" onClick={() => onChoose(selected)}>
                {t("home.continue")} <ChevronRight size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const TLS_MODES: { id: TlsMode; label: string }[] = [
  { id: "prefer", label: t("home.tls.prefer") },
  { id: "disable", label: t("home.tls.disable") },
  { id: "require", label: t("home.tls.require") },
  { id: "verify-ca", label: t("home.tls.verifyCa") },
  { id: "verify-full", label: t("home.tls.verifyFull") },
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
        <ChevronLeft size={14} /> {t("home.changeEngine")}
      </button>
      <div className="security-tabs">
        <button type="button" className={section === "general" ? "active" : ""} onClick={() => setSection("general")}>
          {t("home.tab.general")}
        </button>
        {draft.engine !== "sqlite" ? (
          <>
            <button type="button" className={section === "ssl" ? "active" : ""} onClick={() => setSection("ssl")}>
              SSL
            </button>
            <button type="button" className={section === "tunnel" ? "active" : ""} onClick={() => setSection("tunnel")}>
              {t("home.tab.tunnel")}
            </button>
          </>
        ) : null}
      </div>
      {section === "general" ? (
        <>
          <div className="form-grid">
            <label>
              {t("home.form.name")}
              <input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
            </label>
            <label>
              {t("home.form.group")}
              <input list="connection-groups" value={draft.group} placeholder={t("home.noGroup")} onChange={(event) => patch({ group: event.target.value })} />
              <datalist id="connection-groups">
                {groups.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </label>
            {draft.engine === "sqlite" ? (
              <label className="span-2">
                {t("home.form.file")}
                <div className="password-input">
                  <input value={draft.database} placeholder={t("home.form.filePlaceholder")} onChange={(event) => patch({ database: event.target.value })} />
                  <button type="button" aria-label={t("home.form.chooseFile")} onClick={() => pick("sqlite", (database) => patch({ database }))}>
                    <Folder size={16} />
                  </button>
                </div>
              </label>
            ) : (
              <>
                <label>
                  {t("home.form.host")}
                  <input value={draft.host} onChange={(event) => patch({ host: event.target.value })} />
                </label>
                <label>
                  {t("home.form.port")}
                  <input value={draft.port} onChange={(event) => patch({ port: event.target.value })} />
                </label>
                <label>
                  {t("home.form.database")}
                  <input value={draft.database} onChange={(event) => patch({ database: event.target.value })} />
                </label>
                <label>
                  {t("home.form.username")}
                  <input value={draft.username} onChange={(event) => patch({ username: event.target.value })} />
                </label>
                <label className="span-2">
                  {t("home.form.password")}
                  <div className="password-input">
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="off"
                      value={draft.password}
                      placeholder={draft.credentialAccount ? t("home.form.inKeychain") : ""}
                      onChange={(event) => patch({ password: event.target.value })}
                    />
                    <button type="button" onClick={onTogglePassword} aria-label={showPassword ? t("home.form.hidePassword") : t("home.form.showPassword")}>
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
              {t("home.form.rememberPassword")}
            </label>
          ) : (
            <label className="check-row">
              <input type="checkbox" checked={draft.createIfMissing} onChange={(event) => patch({ createIfMissing: event.target.checked })} />
              {t("home.form.createIfMissing")}
            </label>
          )}
          <div className="secure-note">
            <LockKeyhole size={15} />
            <span>{t("home.form.passwordNote")}</span>
          </div>
          <SafetyFields safety={draft.safety} onChange={(safety) => patch({ safety })} />
        </>
      ) : null}
      {draft.engine !== "sqlite" && section === "ssl" ? (
        <div className="form-grid">
          <label className="span-2">
            {t("home.form.sslMode")}
            <select value={draft.tlsMode} onChange={(event) => patch({ tlsMode: event.target.value as TlsMode })}>
              {TLS_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            {t("home.form.caCert")}
            <div className="password-input">
              <input value={draft.tlsRootCert} placeholder="ca.crt" onChange={(event) => patch({ tlsRootCert: event.target.value })} />
              <button type="button" aria-label={t("home.form.chooseCert")} onClick={() => pick("certificate", (tlsRootCert) => patch({ tlsRootCert }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          <label className="span-2">
            {t("home.form.clientCert")}
            <div className="password-input">
              <input value={draft.tlsClientCert} placeholder="client.crt" onChange={(event) => patch({ tlsClientCert: event.target.value })} />
              <button type="button" aria-label={t("home.form.chooseClientCert")} onClick={() => pick("certificate", (tlsClientCert) => patch({ tlsClientCert }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          <label className="span-2">
            {t("home.form.clientKey")}
            <div className="password-input">
              <input value={draft.tlsClientKey} placeholder="client.key" onChange={(event) => patch({ tlsClientKey: event.target.value })} />
              <button type="button" aria-label={t("home.form.chooseKey")} onClick={() => pick("key", (tlsClientKey) => patch({ tlsClientKey }))}>
                <Folder size={16} />
              </button>
            </div>
          </label>
          {draft.sshEnabled && draft.tlsMode === "verify-full" ? (
            <p className="field-hint span-2">{t("home.form.verifyFullTunnel")}</p>
          ) : null}
        </div>
      ) : null}
      {draft.engine !== "sqlite" && section === "tunnel" ? (
        <>
          <label className="check-row">
            <input type="checkbox" checked={draft.sshEnabled} onChange={(event) => patch({ sshEnabled: event.target.checked })} />
            {t("home.form.useSsh")}
          </label>
          {draft.sshEnabled ? (
            <div className="form-grid">
              <label>
                {t("home.form.sshHost")}
                <input value={draft.sshHost} placeholder={t("home.form.sshHostPlaceholder")} onChange={(event) => patch({ sshHost: event.target.value })} />
              </label>
              <label>
                {t("home.form.port")}
                <input value={draft.sshPort} onChange={(event) => patch({ sshPort: event.target.value })} />
              </label>
              <label>
                {t("home.form.username")}
                <input value={draft.sshUsername} onChange={(event) => patch({ sshUsername: event.target.value })} />
              </label>
              <label>
                {t("home.form.sshAuth")}
                <select value={draft.sshAuth} onChange={(event) => patch({ sshAuth: event.target.value === "password" ? "password" : "key" })}>
                  <option value="key">{t("home.form.privateKey")}</option>
                  <option value="password">{t("home.form.password")}</option>
                </select>
              </label>
              {draft.sshAuth === "key" ? (
                <label className="span-2">
                  {t("home.form.privateKey")}
                  <div className="password-input">
                    <input value={draft.sshPrivateKey} placeholder="~/.ssh/id_ed25519" onChange={(event) => patch({ sshPrivateKey: event.target.value })} />
                    <button type="button" aria-label={t("home.form.chooseKey")} onClick={() => pick("key", (sshPrivateKey) => patch({ sshPrivateKey }))}>
                      <Folder size={16} />
                    </button>
                  </div>
                </label>
              ) : null}
              <label className="span-2">
                {draft.sshAuth === "key" ? t("home.form.passphrase") : t("home.form.sshPassword")}
                <input
                  type="password"
                  autoComplete="off"
                  value={draft.sshSecret}
                  placeholder={draft.sshCredentialAccount ? t("home.form.inKeychain") : ""}
                  onChange={(event) => patch({ sshSecret: event.target.value })}
                />
              </label>
              <label className="check-row span-2">
                <input type="checkbox" checked={draft.rememberSshSecret} onChange={(event) => patch({ rememberSshSecret: event.target.checked })} />
                {t("home.form.rememberSecret")}
              </label>
              {draft.sshHostFingerprint ? (
                <p className="field-hint span-2">
                  {t("home.form.hostKey", { fingerprint: draft.sshHostFingerprint })}{" "}
                  <button type="button" className="text-button" onClick={() => patch({ sshHostFingerprint: "", trustSshHost: false })}>
                    {t("home.form.forget")}
                  </button>
                </p>
              ) : (
                <label className="check-row span-2">
                  <input type="checkbox" checked={draft.trustSshHost} onChange={(event) => patch({ trustSshHost: event.target.checked })} />
                  {t("home.form.trustHost")}
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
          {testing ? t("home.form.testing") : t("home.form.test")}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          {t("home.cancel")}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void onSave(draft, false)}>
          {t("home.form.save")}
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          <Check size={16} /> {t("home.form.connect")}
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
            <span className="modal-kicker">{t("home.group.kicker")}</span>
            <h2>{t("home.newGroup")}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label={t("home.close")}>
            <X size={18} />
          </button>
        </div>
        <p className="modal-description">{t("home.group.description")}</p>
        <label>
          {t("home.group.name")}
          <input autoFocus value={name} placeholder={t("home.group.placeholder")} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("home.cancel")}
          </button>
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
            {t("home.group.create")}
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

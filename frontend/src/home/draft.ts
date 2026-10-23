import { defaultSafety, type ConnectionConfig, type DatabaseEngine, type SafetySettings, type SshAuth, type SshSettings, type TlsMode, type TlsSettings } from "../lib/api";

export type Draft = {
  id: string;
  name: string;
  engine: DatabaseEngine;
  database: string;
  host: string;
  port: string;
  username: string;
  credentialAccount: string | null;
  group: string;
  readOnly: boolean;
  createIfMissing: boolean;
  password: string;
  rememberPassword: boolean;
  tlsMode: TlsMode;
  tlsRootCert: string;
  tlsClientCert: string;
  tlsClientKey: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuth: SshAuth;
  sshPrivateKey: string;
  sshHostFingerprint: string;
  sshCredentialAccount: string | null;
  sshSecret: string;
  rememberSshSecret: boolean;
  trustSshHost: boolean;
  safety: SafetySettings;
};

const blankSecurity = {
  tlsMode: "prefer" as const,
  tlsRootCert: "",
  tlsClientCert: "",
  tlsClientKey: "",
  sshEnabled: false,
  sshHost: "",
  sshPort: "22",
  sshUsername: "",
  sshAuth: "key" as const,
  sshPrivateKey: "",
  sshHostFingerprint: "",
  sshCredentialAccount: null,
  sshSecret: "",
  rememberSshSecret: false,
  trustSshHost: false,
  safety: defaultSafety,
};

export function defaultPort(engine: DatabaseEngine): number {
  return engine === "mysql" ? 3306 : 5432;
}

export function blankDraft(engine: DatabaseEngine): Draft {
  return {
    id: crypto.randomUUID(),
    name: engine === "sqlite" ? "SQLite" : engine === "mysql" ? "MySQL" : "PostgreSQL",
    engine,
    database: "",
    host: "localhost",
    port: String(defaultPort(engine)),
    username: engine === "mysql" ? "root" : "postgres",
    credentialAccount: null,
    group: "",
    readOnly: false,
    createIfMissing: false,
    password: "",
    rememberPassword: false,
    ...blankSecurity,
  };
}

export function draftFromProfile(profile: ConnectionConfig): Draft {
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    database: profile.database,
    host: profile.host ?? "localhost",
    port: String(profile.port ?? (profile.engine === "sqlite" ? "" : defaultPort(profile.engine))),
    username: profile.username ?? "",
    credentialAccount: profile.credentialAccount,
    group: profile.group ?? "",
    readOnly: profile.readOnly,
    createIfMissing: profile.createIfMissing,
    password: "",
    rememberPassword: false,
    tlsMode: profile.tls?.mode ?? "prefer",
    tlsRootCert: profile.tls?.rootCert ?? "",
    tlsClientCert: profile.tls?.clientCert ?? "",
    tlsClientKey: profile.tls?.clientKey ?? "",
    sshEnabled: profile.ssh?.enabled ?? false,
    sshHost: profile.ssh?.host ?? "",
    sshPort: String(profile.ssh?.port ?? 22),
    sshUsername: profile.ssh?.username ?? "",
    sshAuth: profile.ssh?.auth ?? "key",
    sshPrivateKey: profile.ssh?.privateKey ?? "",
    sshHostFingerprint: profile.ssh?.hostFingerprint ?? "",
    sshCredentialAccount: profile.ssh?.credentialAccount ?? null,
    sshSecret: "",
    rememberSshSecret: false,
    trustSshHost: false,
    safety: { ...defaultSafety, ...profile.safety },
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function tlsFromDraft(draft: Draft): TlsSettings {
  if (draft.engine === "sqlite") {
    return { mode: "prefer", rootCert: null, clientCert: null, clientKey: null };
  }
  return {
    mode: draft.tlsMode,
    rootCert: emptyToNull(draft.tlsRootCert),
    clientCert: emptyToNull(draft.tlsClientCert),
    clientKey: emptyToNull(draft.tlsClientKey),
  };
}

function sshFromDraft(draft: Draft): SshSettings {
  return {
    enabled: draft.engine !== "sqlite" && draft.sshEnabled,
    host: emptyToNull(draft.sshHost),
    port: Number(draft.sshPort) || 22,
    username: emptyToNull(draft.sshUsername),
    auth: draft.sshAuth,
    privateKey: emptyToNull(draft.sshPrivateKey),
    hostFingerprint: emptyToNull(draft.sshHostFingerprint),
    credentialAccount: draft.sshCredentialAccount,
  };
}

export function toConfig(draft: Draft): ConnectionConfig {
  const group = draft.group.trim();
  return {
    id: draft.id,
    name: draft.name.trim() || "Conexión",
    engine: draft.engine,
    database: draft.database.trim(),
    host: draft.engine !== "sqlite" ? draft.host.trim() : null,
    port: draft.engine !== "sqlite" ? Number(draft.port) || defaultPort(draft.engine) : null,
    username: draft.engine !== "sqlite" ? draft.username.trim() : null,
    credentialAccount: draft.credentialAccount,
    group: group || null,
    readOnly: draft.readOnly,
    createIfMissing: draft.engine === "sqlite" ? draft.createIfMissing : false,
    tls: tlsFromDraft(draft),
    ssh: sshFromDraft(draft),
    safety: draft.safety,
  };
}

export function subtitle(profile: ConnectionConfig): string {
  if (profile.engine === "sqlite") return profile.database;
  const host = profile.host ?? "localhost";
  const port = profile.port ?? 5432;
  return `${host}:${port} · ${profile.database}`;
}

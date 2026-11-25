// The MCP server form's draft and its round trip to a saved entry. Pure, so
// the form's rules are testable without rendering it.
//
// Secret values never come back from the backend: a value kept in the
// Keychain reads as "saved" (its env name is in `secret_env`, its env value
// is ""), and stays saved unless a new value is typed. Typed secret values
// travel apart from the entry (`configFromDraft`'s `secrets`).
import type { McpRemoteConfig, McpServerConfig } from "../../lib/types";

export type ServerType = "local" | "remote";
export type RemoteAuth = McpRemoteConfig["auth"];
export type RemoteTransport = McpRemoteConfig["transport"];

/** An env variable (Local) or a header (Remote, Custom headers). */
export interface SecretRow {
  name: string;
  /** As typed; "" for a saved secret no new value was typed for. */
  value: string;
  /** "Keep in Keychain". */
  secret: boolean;
  /** The env name a Keychain value is saved under, or null. The row is
   *  saved while its env name is still this one (a rename isn't). */
  savedAs: string | null;
  /** The user set "Keep in Keychain" (or the row was loaded): its name no
   *  longer decides it. */
  touched: boolean;
}

/** The add/edit form's fields, as typed. Both kinds' fields are kept, so
 *  switching the type back and forth loses nothing. */
export interface Draft {
  name: string;
  type: ServerType;
  // Local command
  command: string;
  argsText: string;
  env: SecretRow[];
  // Remote URL
  url: string;
  auth: RemoteAuth;
  token: string;
  tokenSaved: boolean;
  headers: SecretRow[];
  clientId: string;
  clientSecret: string;
  clientSecretSaved: boolean;
  transport: RemoteTransport;
  /** More mcp-remote arguments, one per line (`--enable-proxy`…). */
  extraArgsText: string;
}

// Mirrors of `mcp::remote`'s and `mcp::secrets`' names (their tests pin
// the same examples).
export const HEADER_ENV_PREFIX = "OCTOPUSH_MCP_H_";
export const CLIENT_SECRET_ENV = "OCTOPUSH_MCP_CLIENT_SECRET";
export const TOKEN_HEADER = "Authorization";
// Names whose values are masked and kept in the Keychain by default.
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|BEARER|CREDENTIAL|PRIVATE|COOKIE|SESSION/i;
// The names a save moves to the Keychain on its own (`mcp::secrets::looks_secret`).
const MIGRATED_NAME = /TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER/i;

/** The env var carrying header `name`'s value (`mcp::remote::header_env`). */
export function headerEnv(name: string): string {
  return HEADER_ENV_PREFIX + name.trim().replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/** A header or env name that reads as a credential: its value is masked,
 *  and "Keep in Keychain" starts on for it. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** An env var the bridge owns (a header's value or the client secret). */
function isBridgeEnv(name: string): boolean {
  return name.startsWith(HEADER_ENV_PREFIX) || name === CLIENT_SECRET_ENV;
}

/** A new, empty row. */
export function newRow(): SecretRow {
  return { name: "", value: "", secret: false, savedAs: null, touched: false };
}

/** A row's name changed: "Keep in Keychain" follows the name until the
 *  user sets it. */
export function renameRow(row: SecretRow, name: string): SecretRow {
  return { ...row, name, secret: row.touched ? row.secret : looksSecret(name) };
}

/** The env name a row's value goes under. */
function rowEnv(row: SecretRow, kind: "env" | "header"): string {
  return kind === "header" ? headerEnv(row.name) : row.name.trim();
}

/** The row's Keychain value is saved under its current env name. */
export function rowSaved(row: SecretRow, kind: "env" | "header"): boolean {
  return row.secret && row.savedAs !== null && row.savedAs === rowEnv(row, kind);
}

export function emptyDraft(): Draft {
  return {
    name: "",
    type: "local",
    command: "",
    argsText: "",
    env: [],
    url: "",
    auth: "oauth",
    token: "",
    tokenSaved: false,
    headers: [newRow()],
    clientId: "",
    clientSecret: "",
    clientSecretSaved: false,
    transport: "auto",
    extraArgsText: "",
  };
}

/** A saved row: in the Keychain when its env name is in `secret_env`. */
function loadedRow(name: string, envName: string, cfg: McpServerConfig, migrates: boolean): SecretRow {
  const saved = (cfg.secret_env ?? []).includes(envName);
  const value = cfg.env[envName] ?? "";
  return {
    name,
    value: saved ? "" : value,
    secret: saved || migrates,
    savedAs: saved ? envName : null,
    touched: true,
  };
}

/** A saved server as the form's fields. An entry without `remote` is a
 *  local command, whatever its command is. */
export function draftFrom(name: string, cfg: McpServerConfig): Draft {
  const d = { ...emptyDraft(), name };
  const secretEnv = cfg.secret_env ?? [];
  const plainEnv = cfg.plain_env ?? [];
  const remote = cfg.remote;
  if (!remote) {
    const names = [...Object.keys(cfg.env), ...secretEnv.filter((n) => !(n in cfg.env))];
    return {
      ...d,
      command: cfg.command,
      argsText: cfg.args.join("\n"),
      env: names.map((n) => {
        const v = cfg.env[n] ?? "";
        // A plain value that looks secret moves to the Keychain on the next
        // save (the backend's migration), so it reads as kept there already.
        const migrates = MIGRATED_NAME.test(n) && !plainEnv.includes(n) && v.trim() !== "" && !v.trim().startsWith("$");
        return loadedRow(n, n, cfg, migrates);
      }),
    };
  }
  const tokenEnv = headerEnv(TOKEN_HEADER);
  const tokenSaved = remote.auth === "token" && secretEnv.includes(tokenEnv);
  const names = remote.header_names ?? [];
  const clientSecretSaved = secretEnv.includes(CLIENT_SECRET_ENV);
  return {
    ...d,
    type: "remote",
    url: remote.url,
    auth: remote.auth,
    token: remote.auth === "token" && !tokenSaved ? (cfg.env[tokenEnv] ?? "").replace(/^bearer\s+/i, "") : "",
    tokenSaved,
    headers: names.length ? names.map((n) => loadedRow(n, headerEnv(n), cfg, false)) : d.headers,
    clientId: remote.client_id ?? "",
    clientSecret: clientSecretSaved ? "" : (cfg.env[CLIENT_SECRET_ENV] ?? ""),
    clientSecretSaved,
    transport: remote.transport,
    extraArgsText: (remote.extra_args ?? []).join("\n"),
  };
}

/** The named rows of a list. */
function named(rows: SecretRow[]): SecretRow[] {
  return rows.filter((r) => r.name.trim());
}

/** What a save sends for one server: the entry (secret values as "") and
 *  the secret values typed (env name → value), which go to the Keychain. */
export interface SavedDraft {
  config: McpServerConfig;
  secrets: Record<string, string>;
}

/** The entry a draft saves. `base` is the edited entry: fields the form
 *  doesn't show are kept, and so is a remote entry's own env (a CA path, say).
 *  The backend rebuilds a remote entry's command and args from `remote`. */
export function configFromDraft(draft: Draft, base?: McpServerConfig): SavedDraft {
  const rest: Partial<McpServerConfig> = { ...base };
  delete rest.remote;
  const env: Record<string, string> = {};
  const secretEnv: string[] = [];
  const plainEnv: string[] = [];
  const secrets: Record<string, string> = {};
  const put = (envName: string, row: { value: string; secret: boolean }, plainMayLookSecret: boolean) => {
    if (row.secret) {
      env[envName] = "";
      secretEnv.push(envName);
      if (row.value) secrets[envName] = row.value;
    } else {
      env[envName] = row.value;
      if (plainMayLookSecret && MIGRATED_NAME.test(envName)) plainEnv.push(envName);
    }
  };

  if (draft.type === "local") {
    for (const row of named(draft.env)) put(row.name.trim(), row, true);
    return {
      config: {
        ...rest,
        command: draft.command.trim(),
        args: draft.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
        env,
        secret_env: secretEnv,
        plain_env: plainEnv,
      },
      secrets,
    };
  }

  if (base?.remote) {
    // The remote entry's own env, outside what the form shows.
    for (const [k, v] of Object.entries(base.env)) if (!isBridgeEnv(k)) env[k] = v;
    for (const n of base.secret_env ?? []) if (!isBridgeEnv(n)) secretEnv.push(n);
    for (const n of base.plain_env ?? []) if (!isBridgeEnv(n)) plainEnv.push(n);
  }
  const remote: McpRemoteConfig = { url: draft.url.trim(), auth: draft.auth, transport: draft.transport };
  if (draft.auth === "token") put(headerEnv(TOKEN_HEADER), { value: draft.token.trim(), secret: true }, false);
  if (draft.auth === "headers") {
    const headers = named(draft.headers);
    remote.header_names = headers.map((h) => h.name.trim());
    for (const h of headers) put(headerEnv(h.name), h, false);
  }
  const clientId = draft.clientId.trim();
  if (draft.auth === "oauth" && clientId) {
    remote.client_id = clientId;
    if (draft.clientSecret || draft.clientSecretSaved) {
      put(CLIENT_SECRET_ENV, { value: draft.clientSecret, secret: true }, false);
    }
  }
  const extraArgs = draft.extraArgsText.split("\n").map((a) => a.trim()).filter(Boolean);
  if (extraArgs.length) remote.extra_args = extraArgs;
  return {
    config: { ...rest, command: "npx", args: [], env, secret_env: secretEnv, plain_env: plainEnv, remote },
    secrets,
  };
}

/** A URL mcp-remote 0.16 connects to: https, or plain http on `localhost`
 *  or `127.0.0.1` only (not `[::1]`), unless `--allow-http` is among the
 *  extra arguments. */
function allowedUrl(url: string, extraArgs: string): boolean {
  if (/^https:\/\/\S+$/i.test(url)) return true;
  if (!/^http:\/\/\S+$/i.test(url)) return false;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(url) || /^\s*--allow-http\s*$/m.test(extraArgs);
}

/** Why a draft can't be saved, as shown beside Save, or null. Empty
 *  required fields only disable Save (`draftComplete`). */
export function draftProblem(draft: Draft): string | null {
  if (draft.type === "local") {
    const names = named(draft.env).map((r) => r.name.trim());
    if (names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return "env names use letters, digits and _";
    if (new Set(names).size !== names.length) return "each variable once";
    return null;
  }
  const url = draft.url.trim();
  if (url && !allowedUrl(url, draft.extraArgsText)) return "use an https:// URL (http only for localhost or 127.0.0.1)";
  // mcp-remote puts the secret into the client info's JSON before parsing it.
  if (draft.auth === "oauth" && draft.clientId.trim() && /["\\]/.test(draft.clientSecret)) {
    return "the client secret can't contain \" or \\";
  }
  if (draft.auth === "headers") {
    const headers = named(draft.headers);
    if (headers.some((h) => !/^[A-Za-z0-9_-]+$/.test(h.name.trim()))) return "header names use letters, digits, - and _";
    const envs = headers.map((h) => headerEnv(h.name));
    if (new Set(envs).size !== envs.length) return "each header once";
  }
  return null;
}

/** A secret row has a value: typed, or saved under its name. */
function secretFilled(row: SecretRow, kind: "env" | "header"): boolean {
  return !row.secret || !!row.value || rowSaved(row, kind);
}

/** Every field the draft's type needs is filled in. */
export function draftComplete(draft: Draft): boolean {
  if (!draft.name.trim()) return false;
  if (draft.type === "local") {
    return !!draft.command.trim() && named(draft.env).every((r) => secretFilled(r, "env"));
  }
  if (!draft.url.trim()) return false;
  if (draft.auth === "token") return !!draft.token.trim() || draft.tokenSaved;
  if (draft.auth === "headers") {
    const headers = named(draft.headers);
    return headers.length > 0 && headers.every((h) => secretFilled(h, "header"));
  }
  return true;
}

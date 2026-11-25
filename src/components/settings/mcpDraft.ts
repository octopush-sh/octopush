// The MCP server form's draft and its round trip to a saved entry. Pure, so
// the form's rules are testable without rendering it.
import type { McpRemoteConfig, McpServerConfig } from "../../lib/types";

export type ServerType = "local" | "remote";
export type RemoteAuth = McpRemoteConfig["auth"];
export type RemoteTransport = McpRemoteConfig["transport"];

export interface HeaderRow {
  name: string;
  value: string;
}

/** The add/edit form's fields, as typed. Both kinds' fields are kept, so
 *  switching the type back and forth loses nothing. */
export interface Draft {
  name: string;
  type: ServerType;
  // Local command
  command: string;
  argsText: string;
  envText: string;
  // Remote URL
  url: string;
  auth: RemoteAuth;
  token: string;
  headers: HeaderRow[];
  clientId: string;
  clientSecret: string;
  transport: RemoteTransport;
  /** More mcp-remote arguments, one per line (`--enable-proxy`…). */
  extraArgsText: string;
}

// Mirrors of `mcp::remote`'s names (its tests pin the same examples).
export const HEADER_ENV_PREFIX = "OCTOPUSH_MCP_H_";
export const CLIENT_SECRET_ENV = "OCTOPUSH_MCP_CLIENT_SECRET";
export const TOKEN_HEADER = "Authorization";
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|BEARER|CREDENTIAL|PRIVATE|COOKIE|SESSION/i;

/** The env var carrying header `name`'s value (`mcp::remote::header_env`). */
export function headerEnv(name: string): string {
  return HEADER_ENV_PREFIX + name.trim().replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/** A header or env name that reads as a credential: its value is masked. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** An env var the bridge owns (a header's value or the client secret). */
function isBridgeEnv(name: string): boolean {
  return name.startsWith(HEADER_ENV_PREFIX) || name === CLIENT_SECRET_ENV;
}

/** Parse a "KEY=value" textarea into an env map (blank/##-comment lines skipped). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

export function emptyDraft(): Draft {
  return {
    name: "",
    type: "local",
    command: "",
    argsText: "",
    envText: "",
    url: "",
    auth: "oauth",
    token: "",
    headers: [{ name: "", value: "" }],
    clientId: "",
    clientSecret: "",
    transport: "auto",
    extraArgsText: "",
  };
}

/** A saved server as the form's fields. An entry without `remote` is a
 *  local command, whatever its command is. */
export function draftFrom(name: string, cfg: McpServerConfig): Draft {
  const d = { ...emptyDraft(), name };
  const remote = cfg.remote;
  if (!remote) {
    return {
      ...d,
      command: cfg.command,
      argsText: cfg.args.join("\n"),
      envText: Object.entries(cfg.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    };
  }
  const env = cfg.env;
  const names = remote.header_names ?? [];
  return {
    ...d,
    type: "remote",
    url: remote.url,
    auth: remote.auth,
    token: remote.auth === "token" ? (env[headerEnv(TOKEN_HEADER)] ?? "").replace(/^bearer\s+/i, "") : "",
    headers: names.length ? names.map((n) => ({ name: n, value: env[headerEnv(n)] ?? "" })) : d.headers,
    clientId: remote.client_id ?? "",
    clientSecret: env[CLIENT_SECRET_ENV] ?? "",
    transport: remote.transport,
    extraArgsText: (remote.extra_args ?? []).join("\n"),
  };
}

/** The headers a draft sends, named ones only. */
function namedHeaders(draft: Draft): HeaderRow[] {
  return draft.headers.map((h) => ({ name: h.name.trim(), value: h.value })).filter((h) => h.name);
}

/** The entry a draft saves. `base` is the edited entry: fields the form
 *  doesn't show are kept, and so is a remote entry's own env (a CA path, say).
 *  The backend rebuilds a remote entry's command and args from `remote`. */
export function configFromDraft(draft: Draft, base?: McpServerConfig): McpServerConfig {
  const rest: Partial<McpServerConfig> = { ...base };
  delete rest.remote;
  if (draft.type === "local") {
    return {
      ...rest,
      command: draft.command.trim(),
      args: draft.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
      env: parseEnv(draft.envText),
    };
  }
  const env: Record<string, string> = {};
  if (base?.remote) {
    for (const [k, v] of Object.entries(base.env)) if (!isBridgeEnv(k)) env[k] = v;
  }
  const remote: McpRemoteConfig = { url: draft.url.trim(), auth: draft.auth, transport: draft.transport };
  if (draft.auth === "token") env[headerEnv(TOKEN_HEADER)] = draft.token.trim();
  if (draft.auth === "headers") {
    const headers = namedHeaders(draft);
    remote.header_names = headers.map((h) => h.name);
    for (const h of headers) env[headerEnv(h.name)] = h.value;
  }
  const clientId = draft.clientId.trim();
  if (draft.auth === "oauth" && clientId) {
    remote.client_id = clientId;
    if (draft.clientSecret) env[CLIENT_SECRET_ENV] = draft.clientSecret;
  }
  const extraArgs = draft.extraArgsText.split("\n").map((a) => a.trim()).filter(Boolean);
  if (extraArgs.length) remote.extra_args = extraArgs;
  return { ...rest, command: "npx", args: [], env, remote };
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
  if (draft.type === "local") return null;
  const url = draft.url.trim();
  if (url && !allowedUrl(url, draft.extraArgsText)) return "use an https:// URL (http only for localhost or 127.0.0.1)";
  // mcp-remote puts the secret into the client info's JSON before parsing it.
  if (draft.auth === "oauth" && draft.clientId.trim() && /["\\]/.test(draft.clientSecret)) {
    return "the client secret can't contain \" or \\";
  }
  if (draft.auth === "headers") {
    const headers = namedHeaders(draft);
    if (headers.some((h) => !/^[A-Za-z0-9_-]+$/.test(h.name))) return "header names use letters, digits, - and _";
    const envs = headers.map((h) => headerEnv(h.name));
    if (new Set(envs).size !== envs.length) return "each header once";
  }
  return null;
}

/** Every field the draft's type needs is filled in. */
export function draftComplete(draft: Draft): boolean {
  if (!draft.name.trim()) return false;
  if (draft.type === "local") return !!draft.command.trim();
  if (!draft.url.trim()) return false;
  if (draft.auth === "token") return !!draft.token.trim();
  if (draft.auth === "headers") return namedHeaders(draft).length > 0;
  return true;
}

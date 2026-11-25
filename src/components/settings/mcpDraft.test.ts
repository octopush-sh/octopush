import { describe, it, expect } from "vitest";
import {
  configFromDraft,
  draftComplete,
  draftFrom,
  draftProblem,
  emptyDraft,
  headerEnv,
  looksSecret,
  newRow,
  renameRow,
  rowSaved,
  CLIENT_SECRET_ENV,
  type Draft,
  type SecretRow,
} from "./mcpDraft";
import type { McpServerConfig } from "../../lib/types";

const URL = "https://mcp.example.com/mcp";

function remote(patch: Partial<Draft>): Draft {
  return { ...emptyDraft(), name: "example-remote", type: "remote", url: URL, ...patch };
}

function row(name: string, value: string, secret = false): SecretRow {
  return { name, value, secret, savedAs: null, touched: true };
}

describe("names", () => {
  it("headerEnv matches mcp::remote::header_env", () => {
    expect(headerEnv("Authorization")).toBe("OCTOPUSH_MCP_H_AUTHORIZATION");
    expect(headerEnv(" X-Api-Key ")).toBe("OCTOPUSH_MCP_H_X_API_KEY");
  });

  it("looksSecret matches mcp::secrets::looks_secret", () => {
    for (const n of ["GITHUB_TOKEN", "api_key", "CLIENT_SECRET", "DB_PASSWORD", "AUTH_HEADER", "bearer"]) expect(looksSecret(n)).toBe(true);
    for (const n of ["PATH", "LOG_LEVEL", "NODE_EXTRA_CA_CERTS", "REGION"]) expect(looksSecret(n)).toBe(false);
  });

  it("Keep in Keychain follows a new row's name until the user sets it", () => {
    let r = renameRow(newRow(), "GITHUB_TOKEN");
    expect(r.secret).toBe(true);
    r = renameRow(r, "LOG_LEVEL");
    expect(r.secret).toBe(false);
    r = renameRow({ ...r, secret: true, touched: true }, "REGION");
    expect(r.secret).toBe(true);
  });
});

describe("configFromDraft", () => {
  it("a Browser (OAuth) server is its URL; the backend builds the bridge", () => {
    expect(configFromDraft(remote({}))).toEqual({
      config: { command: "npx", args: [], env: {}, secret_env: [], plain_env: [], remote: { url: URL, auth: "oauth", transport: "auto" } },
      secrets: {},
    });
  });

  it("a token is always a Keychain secret, sent apart from the entry", () => {
    const { config, secrets } = configFromDraft(remote({ auth: "token", token: " tok-123 " }));
    expect(config.env).toEqual({ OCTOPUSH_MCP_H_AUTHORIZATION: "" });
    expect(config.secret_env).toEqual(["OCTOPUSH_MCP_H_AUTHORIZATION"]);
    expect(secrets).toEqual({ OCTOPUSH_MCP_H_AUTHORIZATION: "tok-123" });
    expect(JSON.stringify(config)).not.toContain("tok-123");
    // Saved and nothing typed: it stays saved.
    const kept = configFromDraft(remote({ auth: "token", tokenSaved: true }));
    expect(kept.config.secret_env).toEqual(["OCTOPUSH_MCP_H_AUTHORIZATION"]);
    expect(kept.secrets).toEqual({});
  });

  it("custom headers: secret ones apart, plain ones in env; blank rows dropped", () => {
    const { config, secrets } = configFromDraft(
      remote({ auth: "headers", headers: [row(" X-Api-Key ", "k", true), row("", "stray"), row("X-Tenant", "sample")] }),
    );
    expect(config.remote?.header_names).toEqual(["X-Api-Key", "X-Tenant"]);
    expect(config.env).toEqual({ OCTOPUSH_MCP_H_X_API_KEY: "", OCTOPUSH_MCP_H_X_TENANT: "sample" });
    expect(config.secret_env).toEqual(["OCTOPUSH_MCP_H_X_API_KEY"]);
    expect(secrets).toEqual({ OCTOPUSH_MCP_H_X_API_KEY: "k" });
  });

  it("the OAuth client secret is a Keychain secret, and only with a client id", () => {
    const { config, secrets } = configFromDraft(remote({ clientId: " client-abc ", clientSecret: "shh", transport: "sse-only" }));
    expect(config.remote).toEqual({ url: URL, auth: "oauth", transport: "sse-only", client_id: "client-abc" });
    expect(config.secret_env).toEqual([CLIENT_SECRET_ENV]);
    expect(secrets).toEqual({ [CLIENT_SECRET_ENV]: "shh" });
    const saved = configFromDraft(remote({ clientId: "client-abc", clientSecretSaved: true }));
    expect(saved.secrets).toEqual({});
    expect(saved.config.secret_env).toEqual([CLIENT_SECRET_ENV]);
    const token = configFromDraft(remote({ auth: "token", token: "t", clientId: "client-abc", clientSecret: "shh" }));
    expect(token.config.remote?.client_id).toBeUndefined();
    expect(token.secrets[CLIENT_SECRET_ENV]).toBeUndefined();
  });

  it("local env: secrets apart, plain values in env, and a plain one that looks secret is kept in the file", () => {
    const draft: Draft = {
      ...emptyDraft(),
      name: "example",
      command: "uvx",
      env: [row("GITHUB_TOKEN", "ghp_new", true), row("LOG", "debug"), row("AUTH_MODE", "basic"), row("", "x")],
    };
    const { config, secrets } = configFromDraft(draft);
    expect(config.env).toEqual({ GITHUB_TOKEN: "", LOG: "debug", AUTH_MODE: "basic" });
    expect(config.secret_env).toEqual(["GITHUB_TOKEN"]);
    expect(config.plain_env).toEqual(["AUTH_MODE"]);
    expect(secrets).toEqual({ GITHUB_TOKEN: "ghp_new" });
  });

  it("keeps a remote entry's own env, drops a local entry's when it turns remote", () => {
    const base: McpServerConfig = {
      command: "/opt/homebrew/bin/npx",
      args: ["-y", "mcp-remote", URL],
      env: { NODE_EXTRA_CA_CERTS: "/ca.pem", OCTOPUSH_MCP_H_OLD: "" },
      secret_env: ["OCTOPUSH_MCP_H_OLD"],
      remote: { url: URL, auth: "oauth", transport: "auto" },
    };
    const { config } = configFromDraft(remote({}), base);
    expect(config.env).toEqual({ NODE_EXTRA_CA_CERTS: "/ca.pem" });
    expect(config.secret_env).toEqual([]);
    const local: McpServerConfig = { command: "uvx", args: [], env: { API_KEY: "" }, secret_env: ["API_KEY"] };
    expect(configFromDraft(remote({}), local).config.env).toEqual({});
  });

  it("keeps the keys the form doesn't show, local or remote", () => {
    const local: McpServerConfig = { command: "uvx", args: [], env: {}, cwd: "/repo", type: "stdio" };
    expect(configFromDraft({ ...emptyDraft(), name: "x", command: "uvx", argsText: "a" }, local).config).toEqual({
      command: "uvx",
      args: ["a"],
      env: {},
      secret_env: [],
      plain_env: [],
      cwd: "/repo",
      type: "stdio",
    });
    const remoteBase: McpServerConfig = {
      command: "npx",
      args: [],
      env: {},
      disabled: false,
      remote: { url: URL, auth: "oauth", transport: "auto" },
    };
    expect(configFromDraft(remote({}), remoteBase).config).toMatchObject({ disabled: false, remote: { url: URL } });
  });

  it("a remote entry turned local loses its remote choices", () => {
    const base: McpServerConfig = { command: "npx", args: [], env: {}, remote: { url: URL, auth: "oauth", transport: "auto" } };
    const { config } = configFromDraft({ ...emptyDraft(), name: "x", command: "uvx", argsText: "example-server" }, base);
    expect(config).toEqual({ command: "uvx", args: ["example-server"], env: {}, secret_env: [], plain_env: [] });
  });
});

describe("draftFrom", () => {
  it("a saved secret reads as saved, never with its value", () => {
    const cfg: McpServerConfig = {
      command: "uvx",
      args: ["example-server"],
      env: { GITHUB_TOKEN: "", LOG: "debug", AUTH_MODE: "basic", API_KEY: "legacy-plain" },
      secret_env: ["GITHUB_TOKEN"],
      plain_env: ["AUTH_MODE"],
    };
    const d = draftFrom("example", cfg);
    const byName = Object.fromEntries(d.env.map((r) => [r.name, r]));
    expect(byName.GITHUB_TOKEN).toMatchObject({ value: "", secret: true, savedAs: "GITHUB_TOKEN" });
    expect(rowSaved(byName.GITHUB_TOKEN, "env")).toBe(true);
    expect(byName.LOG).toMatchObject({ value: "debug", secret: false });
    expect(byName.AUTH_MODE).toMatchObject({ value: "basic", secret: false });
    // A plain value that looks secret moves on save, so it reads as kept there.
    expect(byName.API_KEY).toMatchObject({ value: "legacy-plain", secret: true, savedAs: null });
    // Renaming a saved row means a new value.
    expect(rowSaved(renameRow(byName.GITHUB_TOKEN, "GH_TOKEN"), "env")).toBe(false);
  });

  it("a remote server's saved token, headers and client secret", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [],
      env: { OCTOPUSH_MCP_H_AUTHORIZATION: "", [CLIENT_SECRET_ENV]: "" },
      secret_env: ["OCTOPUSH_MCP_H_AUTHORIZATION"],
      remote: { url: URL, auth: "token", transport: "auto" },
    };
    expect(draftFrom("x", cfg)).toMatchObject({ token: "", tokenSaved: true });
    const headers: McpServerConfig = {
      command: "npx",
      args: [],
      env: { OCTOPUSH_MCP_H_X_API_KEY: "", OCTOPUSH_MCP_H_X_TENANT: "sample", [CLIENT_SECRET_ENV]: "" },
      secret_env: ["OCTOPUSH_MCP_H_X_API_KEY", CLIENT_SECRET_ENV],
      remote: { url: URL, auth: "headers", transport: "auto", header_names: ["X-Api-Key", "X-Tenant"] },
    };
    const d = draftFrom("x", headers);
    expect(d.headers.map((h) => [h.name, h.value, h.secret, rowSaved(h, "header")])).toEqual([
      ["X-Api-Key", "", true, true],
      ["X-Tenant", "sample", false, false],
    ]);
    expect(d.clientSecretSaved).toBe(true);
  });

  it("an unsaved token from before the Keychain reads back without its Bearer prefix", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [],
      env: { OCTOPUSH_MCP_H_AUTHORIZATION: "Bearer tok-123" },
      remote: { url: URL, auth: "token", transport: "auto" },
    };
    expect(draftFrom("x", cfg)).toMatchObject({ token: "tok-123", tokenSaved: false });
  });

  it("an entry without remote reads as a local command, even an old hand-written bridge", () => {
    const d = draftFrom("legacy", { command: "npx", args: ["-y", "mcp-remote", URL], env: {} });
    expect(d.type).toBe("local");
    expect(d.argsText).toBe(`-y\nmcp-remote\n${URL}`);
  });
});

describe("draftProblem and draftComplete", () => {
  it("wants an https URL, or http on localhost", () => {
    expect(draftProblem(remote({ url: "http://mcp.example.com/mcp" }))).toMatch(/https/);
    expect(draftProblem(remote({ url: "mcp.example.com" }))).toMatch(/https/);
    expect(draftProblem(remote({ url: "http://localhost:8808/mcp" }))).toBeNull();
    expect(draftProblem(remote({ url: "http://127.0.0.1:3000" }))).toBeNull();
    expect(draftProblem(remote({}))).toBeNull();
  });

  it("checks header and env names and duplicates", () => {
    expect(draftProblem(remote({ auth: "headers", headers: [row("Bad Name", "v")] }))).toMatch(/header names/);
    expect(draftProblem(remote({ auth: "headers", headers: [row("X-Key", "a"), row("x_key", "b")] }))).toBe("each header once");
    const local = (env: SecretRow[]): Draft => ({ ...emptyDraft(), name: "x", command: "uvx", env });
    expect(draftProblem(local([row("1BAD", "v")]))).toMatch(/env names/);
    expect(draftProblem(local([row("A", "1"), row("A", "2")]))).toBe("each variable once");
    expect(draftProblem(local([row("A", "1")]))).toBeNull();
  });

  it("needs what the chosen kind needs, a secret's value included", () => {
    const local = (env: SecretRow[]): Draft => ({ ...emptyDraft(), name: "x", command: "uvx", env });
    expect(draftComplete(local([]))).toBe(true);
    expect(draftComplete({ ...emptyDraft(), name: "x" })).toBe(false);
    expect(draftComplete(local([row("GITHUB_TOKEN", "", true)]))).toBe(false);
    expect(draftComplete(local([{ ...row("GITHUB_TOKEN", "", true), savedAs: "GITHUB_TOKEN" }]))).toBe(true);
    expect(draftComplete(remote({}))).toBe(true);
    expect(draftComplete(remote({ url: " " }))).toBe(false);
    expect(draftComplete(remote({ auth: "token" }))).toBe(false);
    expect(draftComplete(remote({ auth: "token", tokenSaved: true }))).toBe(true);
    expect(draftComplete(remote({ auth: "token", token: "t" }))).toBe(true);
    expect(draftComplete(remote({ auth: "headers" }))).toBe(false);
    expect(draftComplete(remote({ auth: "headers", headers: [row("X-Api-Key", "", true)] }))).toBe(false);
    expect(draftComplete(remote({ name: "" }))).toBe(false);
  });
});

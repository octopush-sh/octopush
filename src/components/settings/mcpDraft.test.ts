import { describe, it, expect } from "vitest";
import {
  configFromDraft,
  draftComplete,
  draftFrom,
  draftProblem,
  emptyDraft,
  headerEnv,
  looksSecret,
  CLIENT_SECRET_ENV,
  type Draft,
} from "./mcpDraft";
import type { McpServerConfig } from "../../lib/types";

const URL = "https://mcp.example.com/mcp";

function remote(patch: Partial<Draft>): Draft {
  return { ...emptyDraft(), name: "example-remote", type: "remote", url: URL, ...patch };
}

describe("headerEnv", () => {
  it("matches mcp::remote::header_env", () => {
    expect(headerEnv("Authorization")).toBe("OCTOPUSH_MCP_H_AUTHORIZATION");
    expect(headerEnv(" X-Api-Key ")).toBe("OCTOPUSH_MCP_H_X_API_KEY");
  });
});

describe("extra arguments", () => {
  it("are kept in remote, one per line, and read back", () => {
    const draft = remote({ extraArgsText: " --enable-proxy \n\n--resource\nhttps://api.example.com" });
    const cfg = configFromDraft(draft);
    expect(cfg.remote?.extra_args).toEqual(["--enable-proxy", "--resource", "https://api.example.com"]);
    expect(draftFrom("x", cfg).extraArgsText).toBe("--enable-proxy\n--resource\nhttps://api.example.com");
    expect(configFromDraft(remote({})).remote?.extra_args).toBeUndefined();
  });

  it("looksSecret marks the header names whose values are masked", () => {
    for (const n of ["Authorization", "X-Api-Key", "Cookie", "X-Session"]) expect(looksSecret(n)).toBe(true);
    for (const n of ["X-Tenant", "Accept"]) expect(looksSecret(n)).toBe(false);
  });
});

describe("configFromDraft", () => {
  it("a Browser (OAuth) server is its URL; the backend builds the bridge", () => {
    expect(configFromDraft(remote({}))).toEqual({
      command: "npx",
      args: [],
      env: {},
      remote: { url: URL, auth: "oauth", transport: "auto" },
    });
  });

  it("a token goes in the Authorization header's env var", () => {
    const cfg = configFromDraft(remote({ auth: "token", token: " tok-123 " }));
    expect(cfg.env).toEqual({ OCTOPUSH_MCP_H_AUTHORIZATION: "tok-123" });
    expect(cfg.remote).toEqual({ url: URL, auth: "token", transport: "auto" });
  });

  it("custom headers keep their names and values; blank rows are dropped", () => {
    const cfg = configFromDraft(
      remote({ auth: "headers", headers: [{ name: " X-Api-Key ", value: "k" }, { name: "", value: "stray" }, { name: "X-Tenant", value: "sample" }] }),
    );
    expect(cfg.remote?.header_names).toEqual(["X-Api-Key", "X-Tenant"]);
    expect(cfg.env).toEqual({ OCTOPUSH_MCP_H_X_API_KEY: "k", OCTOPUSH_MCP_H_X_TENANT: "sample" });
  });

  it("the OAuth client and transport only where they apply", () => {
    const cfg = configFromDraft(remote({ clientId: " client-abc ", clientSecret: "shh", transport: "sse-only" }));
    expect(cfg.remote).toEqual({ url: URL, auth: "oauth", transport: "sse-only", client_id: "client-abc" });
    expect(cfg.env).toEqual({ [CLIENT_SECRET_ENV]: "shh" });
    const token = configFromDraft(remote({ auth: "token", token: "t", clientId: "client-abc", clientSecret: "shh" }));
    expect(token.remote?.client_id).toBeUndefined();
    expect(token.env[CLIENT_SECRET_ENV]).toBeUndefined();
  });

  it("keeps a remote entry's own env, drops a local entry's when it turns remote", () => {
    const base: McpServerConfig = {
      command: "/opt/homebrew/bin/npx",
      args: ["-y", "mcp-remote", URL],
      env: { NODE_EXTRA_CA_CERTS: "/ca.pem", OCTOPUSH_MCP_H_OLD: "gone" },
      remote: { url: URL, auth: "oauth", transport: "auto" },
    };
    expect(configFromDraft(remote({}), base).env).toEqual({ NODE_EXTRA_CA_CERTS: "/ca.pem" });
    const local: McpServerConfig = { command: "uvx", args: [], env: { API_KEY: "x" } };
    expect(configFromDraft(remote({}), local).env).toEqual({});
  });

  it("keeps the keys the form doesn't show, local or remote", () => {
    const local: McpServerConfig = { command: "uvx", args: [], env: {}, cwd: "/repo", type: "stdio" };
    expect(configFromDraft({ ...emptyDraft(), name: "x", command: "uvx", argsText: "a" }, local)).toEqual({
      command: "uvx",
      args: ["a"],
      env: {},
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
    expect(configFromDraft(remote({}), remoteBase)).toMatchObject({ disabled: false, remote: { url: URL } });
  });

  it("a remote entry turned local loses its remote choices", () => {
    const base: McpServerConfig = { command: "npx", args: [], env: {}, remote: { url: URL, auth: "oauth", transport: "auto" } };
    const cfg = configFromDraft({ ...emptyDraft(), name: "x", command: "uvx", argsText: "example-server" }, base);
    expect(cfg).toEqual({ command: "uvx", args: ["example-server"], env: {} });
  });
});

describe("draftFrom round-trips what configFromDraft saved", () => {
  it.each<[string, Partial<Draft>]>([
    ["oauth", { clientId: "client-abc", clientSecret: "shh", transport: "http-only" }],
    ["token", { auth: "token", token: "tok-123" }],
    ["headers", { auth: "headers", headers: [{ name: "X-Api-Key", value: "k" }, { name: "X-Tenant", value: "sample" }] }],
  ])("%s", (_, patch) => {
    const draft = remote(patch);
    const back = draftFrom("example-remote", configFromDraft(draft));
    expect(back).toEqual(draft);
  });

  it("a saved token reads back without its Bearer prefix", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [],
      env: { OCTOPUSH_MCP_H_AUTHORIZATION: "Bearer tok-123" },
      remote: { url: URL, auth: "token", transport: "auto" },
    };
    expect(draftFrom("x", cfg).token).toBe("tok-123");
  });

  it("an entry without remote reads as a local command, even an old hand-written bridge", () => {
    const d = draftFrom("legacy", { command: "npx", args: ["-y", "mcp-remote", URL], env: {} });
    expect(d.type).toBe("local");
    expect(d.argsText).toBe(`-y\nmcp-remote\n${URL}`);
  });
});

describe("draftProblem and draftComplete", () => {
  it("wants an https URL, or http on localhost or 127.0.0.1, as mcp-remote 0.16 does", () => {
    expect(draftProblem(remote({ url: "http://[::1]:8808/mcp" }))).toMatch(/https/);
    expect(draftProblem(remote({ url: "http://mcp.example.com/mcp", extraArgsText: "--allow-http" }))).toBeNull();
    expect(draftProblem(remote({ url: "http://mcp.example.com/mcp" }))).toMatch(/https/);
    expect(draftProblem(remote({ url: "mcp.example.com" }))).toMatch(/https/);
    expect(draftProblem(remote({ url: "http://localhost:8808/mcp" }))).toBeNull();
    expect(draftProblem(remote({ url: "http://127.0.0.1:3000" }))).toBeNull();
    expect(draftProblem(remote({}))).toBeNull();
  });

  it("refuses a client secret that would break the client info's JSON", () => {
    expect(draftProblem(remote({ clientId: "client-abc", clientSecret: 'a"b' }))).toBe("the client secret can't contain \" or \\");
    expect(draftProblem(remote({ clientId: "client-abc", clientSecret: "a\\b" }))).toBe("the client secret can't contain \" or \\");
    expect(draftProblem(remote({ clientId: "client-abc", clientSecret: "plain-secret" }))).toBeNull();
  });

  it("checks header names and duplicates", () => {
    expect(draftProblem(remote({ auth: "headers", headers: [{ name: "Bad Name", value: "v" }] }))).toMatch(/header names/);
    expect(
      draftProblem(remote({ auth: "headers", headers: [{ name: "X-Key", value: "a" }, { name: "x_key", value: "b" }] })),
    ).toBe("each header once");
  });

  it("needs what the chosen kind needs", () => {
    expect(draftComplete({ ...emptyDraft(), name: "x", command: "uvx" })).toBe(true);
    expect(draftComplete({ ...emptyDraft(), name: "x" })).toBe(false);
    expect(draftComplete(remote({}))).toBe(true);
    expect(draftComplete(remote({ url: " " }))).toBe(false);
    expect(draftComplete(remote({ auth: "token" }))).toBe(false);
    expect(draftComplete(remote({ auth: "token", token: "t" }))).toBe(true);
    expect(draftComplete(remote({ auth: "headers" }))).toBe(false);
    expect(draftComplete(remote({ name: "" }))).toBe(false);
  });
});

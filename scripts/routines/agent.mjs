#!/usr/bin/env node
// Run one headless Claude Code agent for a nightly workflow (docs/ROUTINES.md).
//
//   agent.mjs <builder|reviewer|ideas> <prompt-file>
//
// The agent gets NO GitHub credential and only the tools its role needs:
//   - its environment is rebuilt from scratch: PATH, HOME, a scratch TMPDIR and
//     the Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN) — nothing else;
//   - `--permission-mode dontAsk` denies every tool call that isn't allowed
//     below; reads of /proc, /sys, /etc, the runner's home and .git/config are
//     denied on top, so the token can't be read back from the process table;
//   - the builder runs checks only through `octo-check` (agent-check.sh installed
//     root-owned outside the checkout), which runs them as a separate
//     unprivileged user with an empty environment;
//   - no settings files (so no hooks or permission rules from the repo) and no
//     MCP servers are loaded (--setting-sources "", --strict-mcp-config); not
//     --bare, which would refuse the subscription token. CLAUDE.md still loads.
// Whatever the agent produces is files under .agent-out/; fixed workflow steps
// validate them, scan them for the token and do the GitHub writes. Those steps
// run copies of these scripts taken before the agent started, and the
// checkout's .git is moved out of the agent's reach first (no planted hooks or
// config can run where the GitHub token is).
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

export const OUT_DIR = ".agent-out";

/**
 * Tools per role. `tools` is the whole tool set; `allow(cwd)` pre-approves
 * calls — file tools only inside the working directory (an allow-list: with
 * `dontAsk`, a path not listed here is denied, e.g. the runner's action code or
 * tool cache, which run later with a token).
 */
const inside = (cwd) => `/${cwd}/**`; // "//abs/path/**" — an absolute path rule
// Claude Code matches file permissions with two rule kinds: Read(...) covers
// Read/Grep/Glob, Edit(...) covers every tool that writes files (Edit, Write).
// A Write(...) rule matches nothing.
const readHere = (cwd) => [`Read(${inside(cwd)})`];
export const ROLES = {
  builder: {
    model: "claude-opus-5-5",
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    allow: (cwd) => [...readHere(cwd), `Edit(${inside(cwd)})`, "Bash(octo-check:*)"],
  },
  reviewer: {
    model: "claude-opus-5-5",
    tools: ["Read", "Glob", "Grep", "Write"],
    allow: (cwd) => [...readHere(cwd), `Edit(/${cwd}/${OUT_DIR}/**)`],
  },
  ideas: {
    model: "claude-opus-5-5",
    tools: ["Read", "Glob", "Grep", "Write", "WebSearch", "WebFetch"],
    allow: (cwd) => [...readHere(cwd), `Edit(/${cwd}/${OUT_DIR}/**)`, "WebSearch", "WebFetch"],
  },
};

/**
 * Paths no agent may read or write, whatever its role: the process table (the
 * token is in claude's own environment), system config, credential files in
 * the home directory (the repo itself lives under it on GitHub runners, so the
 * home as a whole stays readable), the runner's temp dir and git config.
 */
export function denyRules(runnerTemp = process.env.RUNNER_TEMP) {
  const paths = [
    "//proc/**", "//sys/**", "//etc/**", "//root/**",
    "~/.claude/**", "~/.claude.json", "~/.config/**", "~/.ssh/**", "~/.gitconfig", "~/.git-credentials",
    "~/.npmrc", "~/.docker/**", "~/.aws/**",
    ...(runnerTemp ? [`/${runnerTemp}/**`] : []),
    "./.git/config", "./.git/**/config",
  ];
  return paths.flatMap((p) => [`Read(${p})`, `Edit(${p})`]);
}

/**
 * The claude CLI arguments for a role (pure, tested). The prompt is not one of
 * them: it goes in on stdin. A prompt carrying a large diff and a long PR
 * thread passes Linux's 128 KiB limit on a single argument (E2BIG), and the
 * agent then never starts.
 */
export function claudeArgs(role, runnerTemp = process.env.RUNNER_TEMP, cwd = process.cwd()) {
  const r = ROLES[role];
  if (!r) throw new Error(`unknown role "${role}" (builder | reviewer | ideas)`);
  const settings = { permissions: { allow: r.allow(cwd), deny: denyRules(runnerTemp) } };
  return [
    "-p",
    "--model", process.env.OCTOPUSH_AGENT_MODEL || r.model,
    "--tools", r.tools.join(","),
    "--permission-mode", "dontAsk",
    "--settings", JSON.stringify(settings),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json", // one result object; its permission_denials are summarised
  ];
}

/**
 * A safe one-line-per-entry summary of the tool calls Claude denied: tool name
 * and file path or command only — never content (pure, tested).
 */
export function denialSummary(resultJson) {
  let r;
  try { r = JSON.parse(resultJson); } catch { return ["(no result object — the agent didn't finish normally)"]; }
  const lines = (r.permission_denials ?? []).map((d) => {
    const i = d.tool_input ?? {};
    const what = i.file_path ?? i.path ?? i.pattern ?? (typeof i.command === "string" ? i.command.split(/\s+/)[0] : "");
    return `denied: ${d.tool_name}${what ? ` ${String(what).slice(0, 200)}` : ""}`;
  });
  if (r.is_error || r.subtype && r.subtype !== "success") lines.push(`result: ${r.subtype ?? "error"}`);
  return lines;
}

/** The agent's whole environment (pure, tested). */
export function agentEnv(env = process.env) {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  const tmp = "/tmp/octopush-agent-tmp";
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: tmp,
    LANG: "C.UTF-8",
    CI: "true",
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
  };
}

function main() {
  const [role, promptFile] = process.argv.slice(2);
  if (!role || !promptFile) { console.error("usage: agent.mjs <builder|reviewer|ideas> <prompt-file>"); return 64; }
  const env = agentEnv();
  mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  mkdirSync(OUT_DIR, { recursive: true });
  // The agent's transcript goes to a runner-only file, never to the public
  // Actions log (GitHub masks only the exact secret, not an encoded copy).
  const logFile = join(process.env.RUNNER_TEMP || env.TMPDIR, `agent-${role}-${process.pid}.log`);
  const fd = openSync(logFile, "w", 0o600);
  const r = spawnSync("claude", claudeArgs(role), {
    input: readFileSync(promptFile, "utf8"),
    stdio: ["pipe", fd, fd],
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  closeSync(fd);
  if (r.error) { console.error(`agent: ${r.error.message}`); return 2; }
  console.log(`agent ${role} exited ${r.status} (transcript kept on the runner, not printed)`);
  for (const line of denialSummary(readFileSync(logFile, "utf8"))) console.log(`  ${line}`);
  return r.status ?? 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

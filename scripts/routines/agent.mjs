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
import { readFileSync, mkdirSync } from "node:fs";

export const OUT_DIR = ".agent-out";

const READ_ONLY = ["Read", "Glob", "Grep"];

/** Tools per role. `tools` is the whole tool set; `allow` pre-approves calls. */
export const ROLES = {
  builder: {
    model: "claude-opus-5-5",
    tools: [...READ_ONLY, "Edit", "Write", "Bash"],
    allow: [...READ_ONLY, "Edit", "Write", "Bash(octo-check:*)"],
  },
  reviewer: {
    model: "claude-opus-5-5",
    tools: [...READ_ONLY, "Write"],
    allow: [...READ_ONLY, `Write(${OUT_DIR}/**)`],
  },
  ideas: {
    model: "claude-opus-5-5",
    tools: [...READ_ONLY, "Write", "WebSearch", "WebFetch"],
    allow: [...READ_ONLY, `Write(${OUT_DIR}/**)`, "WebSearch", "WebFetch"],
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
  return paths.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`, `Edit(${p})`, `Write(${p})`]);
}

/** The claude CLI arguments for a role (pure, tested). */
export function claudeArgs(role, prompt, runnerTemp = process.env.RUNNER_TEMP) {
  const r = ROLES[role];
  if (!r) throw new Error(`unknown role "${role}" (builder | reviewer | ideas)`);
  const settings = { permissions: { allow: r.allow, deny: denyRules(runnerTemp) } };
  return [
    "-p", prompt,
    "--model", process.env.OCTOPUSH_AGENT_MODEL || r.model,
    "--tools", r.tools.join(","),
    "--permission-mode", "dontAsk",
    "--settings", JSON.stringify(settings),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "text",
  ];
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
  mkdirSync(env.TMPDIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const r = spawnSync("claude", claudeArgs(role, readFileSync(promptFile, "utf8")), { stdio: "inherit", env });
  if (r.error) { console.error(`agent: ${r.error.message}`); return 2; }
  return r.status ?? 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

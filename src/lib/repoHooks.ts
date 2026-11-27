import type { RepoHooksNotice } from "./ipc";

/** The launcher's line naming what the repo's own Claude Code config runs,
 *  e.g. "This repo's own Claude Code config runs 2 hooks and 1 MCP server." */
export function repoHooksLine(notice: RepoHooksNotice, sandboxed: boolean): string {
  const hooks = notice.hooks.filter((h) => h.kind !== "status_line").length;
  const status = notice.hooks.length - hooks;
  const shells = notice.skillShells.length;
  const parts = [
    hooks > 0 ? `${hooks} ${hooks === 1 ? "hook" : "hooks"}` : "",
    status > 0 ? "a status line" : "",
    notice.servers.length > 0 ? `${notice.servers.length} MCP ${notice.servers.length === 1 ? "server" : "servers"}` : "",
    shells > 0 ? `${shells} skill shell ${shells === 1 ? "command" : "commands"}` : "",
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `This repo's own Claude Code config runs ${list}${sandboxed ? ", and it runs inside the sandbox" : ""}.`;
}

/** One row per entry, mono: "PreToolUse Bash · ./scripts/guard.sh",
 *  "Runs as the skill loads · /deploy · git status --short" (a fenced
 *  block's lines joined by "; "). */
export function repoHooksItems(notice: RepoHooksNotice): string[] {
  return [
    ...notice.hooks.map((h) => `${h.event}${h.matcher ? ` ${h.matcher}` : ""} · ${h.runs}`),
    ...notice.servers.map((s) => `MCP ${s.name} · ${s.runs}`),
    ...notice.skillShells.map((s) => `Runs as the skill loads · /${s.skill} · ${s.command.split("\n").join("; ")}`),
  ];
}

/** The launcher's opt-in and the line under it. */
export const SKILL_SHELL_OFF_LABEL = "Don't run skill shell commands in crews";
export const SKILL_SHELL_OFF_NOTE =
  "Every Claude Code stage of this project's crews and Routines loads skills and commands without running their shell commands. This covers your own and plugin skills in those stages too.";

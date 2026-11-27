import { describe, expect, it } from "vitest";
import { repoHooksItems, repoHooksLine } from "./repoHooks";
import type { RepoHooksNotice } from "./ipc";

const notice = (
  hooks: RepoHooksNotice["hooks"],
  servers: RepoHooksNotice["servers"],
  skillShells: RepoHooksNotice["skillShells"] = [],
): RepoHooksNotice => ({ hooks, servers, skillShells, hash: "h" });

describe("repoHooksLine", () => {
  it("counts hooks, the status line and servers", () => {
    const two = notice(
      [
        { event: "PreToolUse", matcher: "Bash", kind: "command", runs: "a" },
        { event: "Stop", matcher: null, kind: "http", runs: "https://x" },
      ],
      [{ name: "db", runs: "npx db" }, { name: "docs", runs: "https://d" }],
    );
    expect(repoHooksLine(two, false)).toBe("This repo's own Claude Code config runs 2 hooks and 2 MCP servers.");
    expect(repoHooksLine(notice([], [{ name: "db", runs: "npx db" }]), false)).toBe("This repo's own Claude Code config runs 1 MCP server.");
    expect(repoHooksLine(notice([{ event: "statusLine", matcher: null, kind: "status_line", runs: "s" }], []), true)).toBe(
      "This repo's own Claude Code config runs a status line, and it runs inside the sandbox.",
    );
  });

  it("counts skill shell commands", () => {
    const one = [{ skill: "deploy", command: "git status" }];
    expect(repoHooksLine(notice([], [], one), false)).toBe("This repo's own Claude Code config runs 1 skill shell command.");
    expect(
      repoHooksLine(notice([{ event: "Stop", matcher: null, kind: "command", runs: "a" }], [{ name: "db", runs: "x" }], [...one, ...one]), false),
    ).toBe("This repo's own Claude Code config runs 1 hook, 1 MCP server and 2 skill shell commands.");
  });
});

describe("repoHooksItems", () => {
  it("names each entry's event, matcher and what it runs", () => {
    expect(
      repoHooksItems(notice(
        [
          { event: "PostToolUse", matcher: null, kind: "mcp_tool", runs: "linter · lint_file" },
          { event: "PreToolUse", matcher: "Bash", kind: "command", runs: "./guard.sh" },
        ],
        [{ name: "db", runs: "npx -y db-mcp" }],
      )),
    ).toEqual(["PostToolUse · linter · lint_file", "PreToolUse Bash · ./guard.sh", "MCP db · npx -y db-mcp"]);
  });

  it("lists skill shell commands as running when the skill loads, after the rest", () => {
    expect(
      repoHooksItems(notice(
        [],
        [{ name: "db", runs: "npx db" }],
        [{ skill: "deploy", command: "git status --short" }, { skill: "db/reset", command: "dropdb app\ncreatedb app" }],
      )),
    ).toEqual([
      "MCP db · npx db",
      "Runs as the skill loads · /deploy · git status --short",
      "Runs as the skill loads · /db/reset · dropdb app; createdb app",
    ]);
  });
});

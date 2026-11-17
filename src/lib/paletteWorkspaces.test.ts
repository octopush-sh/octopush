import { describe, it, expect } from "vitest";
import { paletteWorkspaces } from "./paletteWorkspaces";
import type { Workspace } from "./types";

const ws = (id: string, name: string, branch: string, lastActive: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, projectId: "p", name, task: "", branch, worktreePath: null, setupScript: "", status: "active",
  createdAt: lastActive, lastActive, glyph: null, tint: null, linkedIssueKey: null, fromBranch: null, ...extra,
});

describe("paletteWorkspaces", () => {
  const projects = [
    {
      name: "octopush",
      workspaces: [
        ws("a", "Old idle", "fix/old", "2026-11-01T10:00:00Z"),
        ws("b", "Recent idle", "feat/recent", "2026-11-16T10:00:00Z"),
        ws("c", "Running one", "feat/run", "2026-11-02T10:00:00Z"),
        ws("gone", "Archived", "feat/archived", "2026-11-17T10:00:00Z", { status: "archived" }),
      ],
    },
    {
      name: "octopush-api",
      workspaces: [
        ws("d", "Waiting long", "pm/issue-772", "2026-10-01T10:00:00Z"),
        ws("e", "Waiting short", "pm/issue-773", "2026-11-17T09:00:00Z"),
      ],
    },
  ];
  const runsByWs = {
    d: [{ id: "r1", status: "paused" as const }],
    e: [{ id: "r2", status: "paused" as const }, { id: "r3", status: "running" as const }],
    b: [{ id: "r4", status: "completed" as const }],
  };
  const statusSince = { r1: 1_000, r2: 5_000 };

  it("lists needs-you first (longest waiting first), then running, then most recently active", () => {
    const rows = paletteWorkspaces(projects, runsByWs, statusSince, { c: true, e: true });
    expect(rows.map((r) => r.id)).toEqual(["d", "e", "c", "b", "a"]);
    expect(rows[0]).toMatchObject({ needsYou: true, project: "octopush-api", branch: "pm/issue-772" });
    expect(rows[2]).toMatchObject({ needsYou: false, running: true });
  });

  it("spans every project and drops archived workspaces", () => {
    const ids = paletteWorkspaces(projects, {}, {}, {}).map((r) => r.id);
    expect(ids).not.toContain("gone");
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("only a paused run needs you — the Dock badge's rule", () => {
    const rows = paletteWorkspaces(projects, { a: [{ id: "x", status: "failed" }], c: [{ id: "y", status: "running" }] }, {}, {});
    expect(rows.every((r) => !r.needsYou)).toBe(true);
  });

  it("keys each row by name, branch and project so a branch fragment matches", () => {
    const row = paletteWorkspaces(projects, {}, {}, {}).find((r) => r.id === "d")!;
    expect(row.keywords).toEqual(["Waiting long", "pm/issue-772", "octopush-api"]);
    expect(row.glyph).toBe("W");
  });
});

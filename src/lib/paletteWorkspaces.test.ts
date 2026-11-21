import { describe, it, expect } from "vitest";
import { defaultFilter } from "cmdk";
import { paletteFilter, paletteShowsProject, paletteWorkspaceMeta, paletteWorkspaces } from "./paletteWorkspaces";
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

  it("uses the rail's monogram: a custom glyph wins over the first letter", () => {
    const custom = [{ name: "p", workspaces: [ws("g", "lower-case name", "b", "2026-11-01T00:00:00Z", { glyph: "★" })] }];
    expect(paletteWorkspaces(custom, {}, {}, {})[0].glyph).toBe("★");
    const plain = [{ name: "p", workspaces: [ws("h", "lower-case name", "b", "2026-11-01T00:00:00Z")] }];
    expect(paletteWorkspaces(plain, {}, {}, {})[0].glyph).toBe("L");
  });

  it("keys each row by name, branch and project so a branch fragment matches", () => {
    const row = paletteWorkspaces(projects, {}, {}, {}).find((r) => r.id === "d")!;
    expect(row.keywords).toEqual(["Waiting long", "pm/issue-772", "octopush-api"]);
    expect(row.glyph).toBe("W");
  });
});

describe("paletteWorkspaceMeta (#935)", () => {
  const PROJECT = "octopush-enterprise-monorepo-with-a-very-long-name";
  const one = [
    {
      name: PROJECT,
      workspaces: [3, 10, 17].map((n) =>
        ws(`r${n}`, `rollback-${n}`, `feature/new-model-rollout-with-staged-canaries-and-rollback-${n}`, "2026-11-01T00:00:00Z"),
      ),
    },
  ];

  it("leaves the project out when every row shares it, so each line is its own branch", () => {
    const rows = paletteWorkspaces(one, {}, {}, {});
    expect(paletteShowsProject(rows)).toBe(false);
    const metas = rows.map((r) => paletteWorkspaceMeta(r, paletteShowsProject(rows)));
    expect(metas.every((m) => !m.includes(PROJECT))).toBe(true);
    expect(new Set(metas).size).toBe(3);
    expect(metas).toContain("feature/new-model-rollout-with-staged-canaries-and-rollback-10");
  });

  it("names the project when the list spans several, outermost first", () => {
    const two = [...one, { name: "octopush-api", workspaces: [ws("d", "Waiting", "pm/issue-772", "2026-10-01T00:00:00Z")] }];
    const rows = paletteWorkspaces(two, {}, {}, {});
    expect(paletteShowsProject(rows)).toBe(true);
    expect(paletteWorkspaceMeta(rows.find((r) => r.id === "d")!, true)).toBe("octopush-api · pm/issue-772");
    expect(paletteWorkspaceMeta({ project: "p", group: "Fixes", branch: "fix/a" }, false)).toBe("Fixes · fix/a");
    expect(paletteWorkspaceMeta({ project: "p", group: "Fixes", branch: "fix/a" }, true)).toBe("p · Fixes · fix/a");
  });
});

describe("paletteFilter", () => {
  const id = "ws:7a72c0de-0772-4dec-a772-dec772dec772";

  it("scores a workspace row on its keywords, not its id", () => {
    expect(paletteFilter(id, "772", ["Palette jump", "pm/issue-770", "octopush"])).toBe(0);
    expect(paletteFilter(id, "770", ["Palette jump", "pm/issue-770", "octopush"])).toBeGreaterThan(0);
    expect(paletteFilter(id, "dec", [])).toBe(0);
  });

  it("scores a model row on its keywords, never its `model:` value (#897)", () => {
    expect(paletteFilter("model:anthropic/opus-46", "model", ["Claude Opus 4.6", "anthropic"])).toBe(0);
    expect(paletteFilter("model:anthropic/opus-46", "opus", ["Claude Opus 4.6", "anthropic"])).toBeGreaterThan(0);
  });

  it("leaves every other row on cmdk's default scoring", () => {
    expect(paletteFilter("Toggle word wrap", "wrap", undefined)).toBe(defaultFilter("Toggle word wrap", "wrap", undefined));
    expect(paletteFilter("Sonnet", "anth", ["anthropic"])).toBe(defaultFilter("Sonnet", "anth", ["anthropic"]));
    expect(paletteFilter("Sonnet", "anth", ["anthropic"])).toBeGreaterThan(0);
  });
});

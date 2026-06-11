/**
 * Tests for workspaceStore.
 *
 * Invariants under test:
 * 1. remove() drops the workspace from BOTH the flat `workspaces` list AND the
 *    per-project `workspacesByProjectId` map (the rail reads the latter, so a
 *    stale entry there keeps a deleted workspace visible — the reported bug).
 * 2. load() activates the remembered workspace for a project when present,
 *    falling back to the first. This is the mechanism cross-project selection
 *    relies on (see rememberActiveForProject + App.handleSelectWorkspace).
 * 3. rememberActiveForProject() records + persists the per-project selection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workspace, ProjectInfo } from "../lib/types";

function makeProject(id: string): ProjectInfo {
  return { id, name: id.toUpperCase(), path: `/repo/${id}`, jiraProjectKey: null, pinned: false, tint: null };
}

let nextId = 0;
function makeWorkspace(projectId: string, name: string): Workspace {
  return {
    id: `ws-${++nextId}`,
    projectId,
    name,
    task: "",
    branch: `feat/${name}`,
    worktreePath: `/repo/${name}`,
    setupScript: "",
    status: "active",
    createdAt: "",
    lastActive: "",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    fromBranch: null,
  };
}

const mockIpc = {
  listWorkspaces: vi.fn<(projectId: string) => Promise<Workspace[]>>(),
  deleteWorkspace:
    vi.fn<
      (
        workspaceId: string,
        projectPath: string,
        branch: string,
        worktreePath: string | null,
      ) => Promise<void>
    >(),
  createWorkspace: vi.fn(),
  updateWorkspaceCustomization: vi.fn(),
  workspacesGitSummary: vi.fn(),
  archiveWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  openPrsForProject: vi.fn(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useWorkspaceStore, __resetPrFetchThrottle } = await import("./workspaceStore");
const { useProjectStore } = await import("./projectStore");

function resetStore() {
  useWorkspaceStore.setState({
    workspaces: [],
    activeId: null,
    loading: false,
    notifications: {},
    lastActiveByProject: {},
    workspacesByProjectId: {},
    gitSummaryByWs: {},
    prByWs: {},
  });
  // The PR-fetch dedup Set + throttle Map live at module scope and persist
  // across tests; clear them so a shared projectId isn't throttled/blocked
  // between tests that each call loadProjectPrs once.
  __resetPrFetchThrottle();
  nextId = 0;
  useProjectStore.setState({ current: null, recent: [], closed: [], loading: false, error: null });
  vi.clearAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom always has localStorage */
  }
}

describe("workspaceStore — remove", () => {
  beforeEach(() => resetStore());

  it("removes the workspace from BOTH workspaces and workspacesByProjectId", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-1", "beta");
    useWorkspaceStore.setState({
      workspaces: [a, b],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a, b] },
    });
    mockIpc.deleteWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore
      .getState()
      .remove(a.id, "/repo", a.branch, a.worktreePath);

    const s = useWorkspaceStore.getState();
    // Flat list updated.
    expect(s.workspaces.map((w) => w.id)).toEqual([b.id]);
    // Per-project map updated — this is what the rail renders.
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([b.id]);
    // Active cleared because the removed workspace was active.
    expect(s.activeId).toBeNull();
  });

  it("removes a workspace that lives in a non-active project's group", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-2", "beta");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a], "proj-2": [b] },
    });
    mockIpc.deleteWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore
      .getState()
      .remove(b.id, "/repo2", b.branch, b.worktreePath);

    const s = useWorkspaceStore.getState();
    expect(s.workspacesByProjectId["proj-2"]).toEqual([]);
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([a.id]);
    // Active untouched — we deleted a different project's workspace.
    expect(s.activeId).toBe(a.id);
  });
});

describe("workspaceStore — load activation", () => {
  beforeEach(() => resetStore());

  it("activates the remembered workspace for the project when present", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-1", "beta");
    mockIpc.listWorkspaces.mockResolvedValueOnce([a, b]);
    useWorkspaceStore.setState({ lastActiveByProject: { "proj-1": b.id } });

    await useWorkspaceStore.getState().load("proj-1");

    expect(useWorkspaceStore.getState().activeId).toBe(b.id);
  });

  it("falls back to the first workspace when nothing is remembered", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-1", "beta");
    mockIpc.listWorkspaces.mockResolvedValueOnce([a, b]);

    await useWorkspaceStore.getState().load("proj-1");

    expect(useWorkspaceStore.getState().activeId).toBe(a.id);
  });
});

describe("workspaceStore — create (project-aware, C3)", () => {
  beforeEach(() => resetStore());

  it("appends + activates when creating for the currently-open project", async () => {
    useProjectStore.setState({ current: makeProject("proj-1") });
    const existing = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [existing],
      activeId: existing.id,
      workspacesByProjectId: { "proj-1": [existing] },
    });
    const created = makeWorkspace("proj-1", "beta");
    mockIpc.createWorkspace.mockResolvedValueOnce(created);

    await useWorkspaceStore
      .getState()
      .create("proj-1", "/repo", "beta", "", created.branch, "main", "");

    const s = useWorkspaceStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual([existing.id, created.id]);
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([
      existing.id,
      created.id,
    ]);
    expect(s.activeId).toBe(created.id);
  });

  it("does NOT pollute the flat list or activeId when creating for a non-active project", async () => {
    useProjectStore.setState({ current: makeProject("proj-1") });
    const activeWs = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [activeWs],
      activeId: activeWs.id,
      workspacesByProjectId: { "proj-1": [activeWs] },
    });
    const created = makeWorkspace("proj-2", "gamma");
    mockIpc.createWorkspace.mockResolvedValueOnce(created);

    await useWorkspaceStore
      .getState()
      .create("proj-2", "/repo2", "gamma", "", created.branch, "main", "");

    const s = useWorkspaceStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual([activeWs.id]);
    expect(s.activeId).toBe(activeWs.id);
    expect(s.workspacesByProjectId["proj-2"].map((w) => w.id)).toEqual([created.id]);
  });
});

describe("workspaceStore — pruneProject (C8)", () => {
  beforeEach(() => resetStore());

  it("removes the project's group and clears active when the pruned project was active", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a] },
    });

    useWorkspaceStore.getState().pruneProject("proj-1");

    const s = useWorkspaceStore.getState();
    expect(s.workspacesByProjectId["proj-1"]).toBeUndefined();
    expect(s.workspaces).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  it("leaves the flat list + active intact when pruning a non-active project", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-2", "beta");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a], "proj-2": [b] },
    });

    useWorkspaceStore.getState().pruneProject("proj-2");

    const s = useWorkspaceStore.getState();
    expect(s.workspacesByProjectId["proj-2"]).toBeUndefined();
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([a.id]);
    expect(s.workspaces.map((w) => w.id)).toEqual([a.id]);
    expect(s.activeId).toBe(a.id);
  });

  it("drops git summaries for the pruned project's workspaces", () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-2", "beta");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a], "proj-2": [b] },
      gitSummaryByWs: {
        [a.id]: { workspaceId: a.id, dirty: true, ahead: 0, behind: 0 },
        [b.id]: { workspaceId: b.id, dirty: false, ahead: 0, behind: 0 },
      },
    });

    useWorkspaceStore.getState().pruneProject("proj-1");

    const s = useWorkspaceStore.getState();
    expect(s.gitSummaryByWs[a.id]).toBeUndefined(); // pruned project's summary gone
    expect(s.gitSummaryByWs[b.id]).toBeDefined();   // other project's summary kept
  });
});

describe("workspaceStore — rememberActiveForProject", () => {
  beforeEach(() => resetStore());

  it("records and persists the per-project selection", () => {
    useWorkspaceStore.getState().rememberActiveForProject("proj-9", "ws-42");

    expect(useWorkspaceStore.getState().lastActiveByProject["proj-9"]).toBe(
      "ws-42",
    );
    const persisted = JSON.parse(
      localStorage.getItem("lastActiveWorkspacePerProject") || "{}",
    );
    expect(persisted["proj-9"]).toBe("ws-42");
  });
});

describe("workspaceStore — git summary cache", () => {
  beforeEach(() => resetStore());

  it("merges fetched summaries into gitSummaryByWs keyed by workspace id", async () => {
    mockIpc.workspacesGitSummary.mockResolvedValueOnce([
      { workspaceId: "w1", dirty: true, ahead: 2, behind: 0 },
      { workspaceId: "w2", dirty: false, ahead: 0, behind: 1 },
    ]);

    await useWorkspaceStore.getState().loadGitSummaries("proj-1");

    const map = useWorkspaceStore.getState().gitSummaryByWs;
    expect(map.w1).toEqual({ workspaceId: "w1", dirty: true, ahead: 2, behind: 0 });
    expect(map.w2.behind).toBe(1);
  });

  it("preserves summaries from other projects when merging", async () => {
    useWorkspaceStore.setState({
      gitSummaryByWs: { other: { workspaceId: "other", dirty: true, ahead: 0, behind: 0 } },
    });
    mockIpc.workspacesGitSummary.mockResolvedValueOnce([
      { workspaceId: "w1", dirty: false, ahead: 0, behind: 0 },
    ]);

    await useWorkspaceStore.getState().loadGitSummaries("proj-1");

    const map = useWorkspaceStore.getState().gitSummaryByWs;
    expect(map.other).toBeDefined();
    expect(map.w1).toBeDefined();
  });

  it("drops a workspace's summary on remove", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      workspacesByProjectId: { "proj-1": [a] },
      gitSummaryByWs: { [a.id]: { workspaceId: a.id, dirty: true, ahead: 0, behind: 0 } },
    });
    mockIpc.deleteWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore.getState().remove(a.id, "/repo", a.branch, a.worktreePath);

    expect(useWorkspaceStore.getState().gitSummaryByWs[a.id]).toBeUndefined();
  });
});

describe("workspaceStore — archive & rename", () => {
  beforeEach(() => resetStore());

  it("archive removes the workspace from the rail maps (like remove)", async () => {
    const a = makeWorkspace("p1", "alpha");
    const b = makeWorkspace("p1", "beta");
    useWorkspaceStore.setState({
      workspaces: [a, b],
      activeId: a.id,
      workspacesByProjectId: { p1: [a, b] },
    });
    mockIpc.archiveWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore.getState().archive(a.id, "/repo", a.branch, a.worktreePath);

    const s = useWorkspaceStore.getState();
    expect(mockIpc.archiveWorkspace).toHaveBeenCalledWith(a.id, "/repo", a.branch, a.worktreePath);
    expect(s.workspacesByProjectId.p1.map((w) => w.id)).toEqual([b.id]);
    expect(s.workspaces.map((w) => w.id)).toEqual([b.id]);
    expect(s.activeId).toBeNull();
  });

  it("rename updates the name in both maps", async () => {
    const a = makeWorkspace("p1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      workspacesByProjectId: { p1: [a] },
    });
    mockIpc.renameWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore.getState().rename(a.id, "renamed");

    const s = useWorkspaceStore.getState();
    expect(mockIpc.renameWorkspace).toHaveBeenCalledWith(a.id, "renamed");
    expect(s.workspaces[0].name).toBe("renamed");
    expect(s.workspacesByProjectId.p1[0].name).toBe("renamed");
  });
});

describe("workspaceStore — prByWs", () => {
  beforeEach(() => resetStore());

  it("maps open PRs onto workspaces by branch (and null when none)", async () => {
    const a = makeWorkspace("p1", "alpha");
    const b = makeWorkspace("p1", "beta");
    useWorkspaceStore.setState({ workspacesByProjectId: { p1: [a, b] } });
    mockIpc.openPrsForProject.mockResolvedValueOnce([
      { branch: a.branch, pr: { number: 1, title: "A", url: "u1", isDraft: false, state: "open" } },
    ]);

    await useWorkspaceStore.getState().loadProjectPrs("p1", "/repo/p1");

    const map = useWorkspaceStore.getState().prByWs;
    expect(map[a.id]?.number).toBe(1);
    expect(map[b.id]).toBeNull();
    expect(mockIpc.openPrsForProject).toHaveBeenCalledWith("/repo/p1");
  });

  it("preserves prByWs entries from other projects", async () => {
    const a = makeWorkspace("p1", "alpha");
    useWorkspaceStore.setState({
      workspacesByProjectId: { p1: [a] },
      prByWs: { other: { number: 9, title: "O", url: "uo", isDraft: false, state: "open" } },
    });
    mockIpc.openPrsForProject.mockResolvedValueOnce([]);

    await useWorkspaceStore.getState().loadProjectPrs("p1", "/repo/p1");

    const map = useWorkspaceStore.getState().prByWs;
    expect(map.other).toBeDefined();
    expect(map[a.id]).toBeNull();
  });
});

describe("workspaceStore — updateCustomization", () => {
  beforeEach(() => {
    resetStore();
    const a = makeWorkspace("p1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      workspacesByProjectId: { p1: [a] },
      activeId: a.id,
    });
  });

  it("updates the rail map (workspacesByProjectId), not just workspaces", async () => {
    mockIpc.updateWorkspaceCustomization.mockResolvedValueOnce(undefined);
    const wsId = useWorkspaceStore.getState().workspaces[0].id;

    await useWorkspaceStore
      .getState()
      .updateCustomization(wsId, "★", "verdigris");

    const fromMap = useWorkspaceStore.getState().workspacesByProjectId.p1[0];
    expect(fromMap.glyph).toBe("★");
    expect(fromMap.tint).toBe("verdigris");
  });
});

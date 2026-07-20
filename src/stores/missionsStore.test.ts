/**
 * Unit tests for missionsStore.
 *
 * Covers: load indexes by project + by workspace; missions without a worktree
 * stay out of the workspace index; loadAll merges projects; reload replaces a
 * project's rows (stale entries dropped); create round-trips through ipc.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mission } from "../lib/types";

// ─── Mocks ────────────────────────────────────────────────────────────

const listMissionsMock = vi.fn<(projectId: string) => Promise<Mission[]>>().mockResolvedValue([]);
const createMissionMock = vi.fn();
const updateMissionMock = vi.fn();
const archiveMissionMock = vi.fn().mockResolvedValue(undefined);
const getMissionMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    listMissions: listMissionsMock,
    createMission: createMissionMock,
    updateMission: updateMissionMock,
    archiveMission: archiveMissionMock,
    getMission: getMissionMock,
  },
}));

const { useMissionsStore } = await import("./missionsStore");

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    workspaceId: "w1",
    projectId: "p1",
    intent: "build",
    title: "T",
    status: "active",
    linkedIssueKey: null,
    gitIsolation: "worktree",
    execIsolation: "none",
    payload: "{}",
    createdAt: "t",
    updatedAt: "t",
    archivedAt: null,
    ...over,
  };
}

function reset() {
  useMissionsStore.setState({ missionsByProjectId: {}, missionByWorkspaceId: {} });
  listMissionsMock.mockReset().mockResolvedValue([]);
  createMissionMock.mockReset();
  updateMissionMock.mockReset();
  archiveMissionMock.mockReset().mockResolvedValue(undefined);
  getMissionMock.mockReset();
}

describe("missionsStore", () => {
  beforeEach(reset);

  it("load indexes missions by project and by workspace", async () => {
    listMissionsMock.mockResolvedValue([
      mission({ id: "m1", workspaceId: "w1" }),
      mission({ id: "m2", workspaceId: "w2", intent: "fix" }),
    ]);
    await useMissionsStore.getState().load("p1");
    const s = useMissionsStore.getState();
    expect(s.missionsByProjectId["p1"]).toHaveLength(2);
    expect(s.missionByWorkspaceId["w1"].intent).toBe("build");
    expect(s.missionByWorkspaceId["w2"].intent).toBe("fix");
  });

  it("missions with no workspace stay out of the workspace index", async () => {
    listMissionsMock.mockResolvedValue([mission({ id: "d1", workspaceId: null, intent: "design" })]);
    await useMissionsStore.getState().load("p1");
    expect(Object.keys(useMissionsStore.getState().missionByWorkspaceId)).toHaveLength(0);
    expect(useMissionsStore.getState().missionsByProjectId["p1"]).toHaveLength(1);
  });

  it("loadAll merges multiple projects and reindexes", async () => {
    listMissionsMock.mockImplementation(async (pid: string) =>
      pid === "p1"
        ? [mission({ id: "m1", workspaceId: "w1" })]
        : [mission({ id: "m2", workspaceId: "w2", projectId: "p2" })],
    );
    await useMissionsStore.getState().loadAll(["p1", "p2"]);
    const s = useMissionsStore.getState();
    expect(Object.keys(s.missionsByProjectId)).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(s.missionByWorkspaceId["w1"]).toBeTruthy();
    expect(s.missionByWorkspaceId["w2"]).toBeTruthy();
  });

  it("reload replaces a project's missions (stale rows dropped from both indexes)", async () => {
    listMissionsMock.mockResolvedValue([mission({ id: "m1", workspaceId: "w1" })]);
    await useMissionsStore.getState().load("p1");
    listMissionsMock.mockResolvedValue([mission({ id: "m2", workspaceId: "w2" })]);
    await useMissionsStore.getState().load("p1");
    const s = useMissionsStore.getState();
    expect(s.missionsByProjectId["p1"].map((m) => m.id)).toEqual(["m2"]);
    expect(s.missionByWorkspaceId["w1"]).toBeUndefined();
    expect(s.missionByWorkspaceId["w2"]).toBeTruthy();
  });

  it("a stale load that resolves after a newer one does not clobber the newer result", async () => {
    // Simulate an older request (e.g. a focus-triggered loadAll issued before
    // a mission was created) that resolves AFTER a fresher one issued later
    // (e.g. MissionCreator's post-create refresh). The stale response must be
    // discarded, not applied last-write-wins.
    let resolveStale: (missions: Mission[]) => void;
    const stalePromise = new Promise<Mission[]>((resolve) => {
      resolveStale = resolve;
    });
    listMissionsMock.mockReturnValueOnce(stalePromise);
    const stale = useMissionsStore.getState().load("p1");

    listMissionsMock.mockResolvedValueOnce([mission({ id: "fresh", workspaceId: "w9" })]);
    const fresh = useMissionsStore.getState().load("p1");
    await fresh;

    // The stale request resolves last, but should be a no-op.
    resolveStale!([mission({ id: "old", workspaceId: "w1" })]);
    await stale;

    const s = useMissionsStore.getState();
    expect(s.missionsByProjectId["p1"].map((m) => m.id)).toEqual(["fresh"]);
    expect(s.missionByWorkspaceId["w9"]).toBeTruthy();
    expect(s.missionByWorkspaceId["w1"]).toBeUndefined();
  });

  it("create calls ipc with the right args then reloads the project", async () => {
    createMissionMock.mockResolvedValue(mission({ id: "new", workspaceId: "w9" }));
    listMissionsMock.mockResolvedValue([mission({ id: "new", workspaceId: "w9" })]);
    const m = await useMissionsStore
      .getState()
      .create("p1", "build", "T", "worktree", "none", "w9", null);
    expect(m.id).toBe("new");
    expect(createMissionMock).toHaveBeenCalledWith("p1", "build", "T", "worktree", "none", "w9", null);
    expect(useMissionsStore.getState().missionByWorkspaceId["w9"]).toBeTruthy();
  });
});

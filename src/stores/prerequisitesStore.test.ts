/**
 * prerequisitesStore ("Starts after", #960 slice 2): a met link is cleared and
 * its mission's start offered once (staged, or begun with auto-start); a
 * stopped prerequisite run keeps the mission waiting and says why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prerequisite, Run, RunStage } from "../lib/ipc";
import type { Workspace } from "../lib/types";
import type { LauncherPrefill } from "./runsStore";

const mockIpc = {
  listWorkspacePrerequisites: vi.fn<(projectId: string) => Promise<Prerequisite[]>>(),
  setWorkspacePrerequisite: vi.fn(),
  clearWorkspacePrerequisite: vi.fn<(id: string) => Promise<void>>(),
  listRuns: vi.fn<(id: string) => Promise<Run[]>>(),
  getRun: vi.fn<(id: string) => Promise<{ run: Run | null; stages: RunStage[] }>>(),
  findPrForBranch: vi.fn(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));
const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));
const { begin, setLauncherPrefill, selectRun } = vi.hoisted(() => ({ begin: vi.fn(), setLauncherPrefill: vi.fn(), selectRun: vi.fn() }));
vi.mock("./runsStore", async () => {
  const { create } = await import("zustand");
  return {
    useRunsStore: create(() => ({
      activeRunIdByWs: {} as Record<string, string | null>, launcherPrefill: null as unknown, begin, setLauncherPrefill, selectRun,
    })),
  };
});

const { usePrerequisitesStore, __resetPrerequisites } = await import("./prerequisitesStore");
const { useWorkspaceStore } = await import("./workspaceStore");
const { useRunsStore } = await import("./runsStore");

const workspace = (id: string, task = ""): Workspace => ({
  id, projectId: "p1", name: id, task, branch: id, worktreePath: `/wt/${id}`, setupScript: "",
  status: "active", createdAt: "", lastActive: "", glyph: null, tint: null, linkedIssueKey: null, fromBranch: null,
});
const link = (over: Partial<Prerequisite> = {}): Prerequisite => ({
  workspaceId: "w2", afterWorkspaceId: "w1", afterCondition: "run_finished",
  branchFromPrerequisite: false, autoStart: false, ...over,
});
const run = (status: Run["status"], pipelineId = "crew-a"): Run =>
  ({ id: `r-${status}`, workspaceId: "w1", pipelineId, task: "t", status }) as Run;
const pr = (state: string) => ({ number: 7, title: "", url: "", isDraft: false, state });
const load = (links: Prerequisite[]) => {
  mockIpc.listWorkspacePrerequisites.mockResolvedValue(links);
  return usePrerequisitesStore.getState().load(["p1"]);
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrerequisites();
  usePrerequisitesStore.setState({ byWs: {}, holdByWs: {} });
  useRunsStore.setState({ activeRunIdByWs: {}, launcherPrefill: null });
  setLauncherPrefill.mockImplementation((p: LauncherPrefill | null) => useRunsStore.setState({ launcherPrefill: p }));
  useWorkspaceStore.setState({
    workspacesByProjectId: { p1: [workspace("w1", "Ship the docs"), workspace("w2", "Wire the token store")] },
  });
  mockIpc.clearWorkspacePrerequisite.mockResolvedValue(undefined);
});

describe("prerequisitesStore", () => {
  it("stages the run once the prerequisite's run passed its last gate, and offers it once", async () => {
    mockIpc.listRuns.mockResolvedValue([run("draft", "other"), run("completed")]);
    await load([link()]);

    expect(mockIpc.clearWorkspacePrerequisite).toHaveBeenCalledWith("w2");
    expect(usePrerequisitesStore.getState().byWs).toEqual({});
    expect(begin).not.toHaveBeenCalled();
    expect(setLauncherPrefill).toHaveBeenCalledWith({
      task: "Wire the token store", pipelineId: "crew-a", overrides: [], workspaceId: "w2",
    });
    expect(selectRun).toHaveBeenCalledWith("w2", null);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      level: "info", title: "w2 is ready to start", body: expect.stringContaining("w1's run passed its last gate."),
    }));

    await usePrerequisitesStore.getState().check();
    expect(mockIpc.clearWorkspacePrerequisite).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting on a halted run, and says so", async () => {
    mockIpc.listRuns.mockResolvedValue([run("paused")]);
    const stages = [{ status: "done", checkpoint: true }, { status: "failed", checkpoint: false }] as RunStage[];
    mockIpc.getRun.mockResolvedValue({ run: run("paused"), stages });
    await load([link()]);

    expect(mockIpc.clearWorkspacePrerequisite).not.toHaveBeenCalled();
    expect(usePrerequisitesStore.getState().byWs.w2).toEqual(link());
    expect(usePrerequisitesStore.getState().holdByWs).toEqual({ w2: "halted" });
    expect(setLauncherPrefill).not.toHaveBeenCalled();
  });

  it("begins the run on its own when a merged PR meets an auto-start link", async () => {
    mockIpc.findPrForBranch.mockResolvedValue(pr("merged"));
    mockIpc.listRuns.mockResolvedValue([run("completed", "crew-b")]);
    begin.mockImplementation(async (ws: string) => useRunsStore.setState({ activeRunIdByWs: { [ws]: "r-new" } }));
    await load([link({ afterCondition: "pr_merged", autoStart: true })]);

    expect(mockIpc.findPrForBranch).toHaveBeenCalledWith("/wt/w1");
    expect(begin).toHaveBeenCalledWith("w2", "crew-b", "Wire the token store", [], undefined);
    expect(setLauncherPrefill).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "success", title: "w2 started" }));

    // A refused auto-start (the upgrade sheet took it: no run) is staged instead.
    begin.mockReset().mockResolvedValue(undefined);
    await load([link({ afterCondition: "pr_merged", autoStart: true, workspaceId: "w1", afterWorkspaceId: "w2" })]);
    expect(begin).toHaveBeenCalledWith("w1", "crew-b", "Ship the docs", [], undefined);
    expect(setLauncherPrefill).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", pipelineId: "crew-b" }));
  });

  it("asks GitHub about an unmerged PR at most once per poll", async () => {
    mockIpc.findPrForBranch.mockResolvedValue(pr("open"));
    await load([link({ afterCondition: "pr_merged" })]);
    await usePrerequisitesStore.getState().check();

    expect(mockIpc.findPrForBranch).toHaveBeenCalledTimes(1);
    expect(usePrerequisitesStore.getState().byWs.w2).toBeDefined();
  });

  it("save passes auto-start through; a refusal is toasted in plain words", async () => {
    mockIpc.setWorkspacePrerequisite.mockResolvedValueOnce(link({ autoStart: true }));
    mockIpc.listRuns.mockResolvedValue([]);
    expect(await usePrerequisitesStore.getState().save("p1", "w2", "w1", "run_finished", true)).toBe(true);
    expect(mockIpc.setWorkspacePrerequisite).toHaveBeenCalledWith("w2", "w1", "run_finished", true);
    expect(usePrerequisitesStore.getState().byWs.w2).toEqual(link({ autoStart: true }));

    mockIpc.setWorkspacePrerequisite.mockRejectedValueOnce("other: These missions would wait on each other.");
    expect(await usePrerequisitesStore.getState().save("p1", "w1", "w2", "run_finished", false)).toBe(false);
    expect(usePrerequisitesStore.getState().byWs.w1).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "These missions would wait on each other." }));
  });

  it("stages one mission at a time when two links are met at once", async () => {
    useWorkspaceStore.setState({
      workspacesByProjectId: { p1: [workspace("w1"), workspace("w2", "Wire the token store"), workspace("w3", "Write the guide")] },
    });
    mockIpc.listRuns.mockResolvedValue([run("completed")]);
    await load([link(), link({ workspaceId: "w3" })]);

    // w2's seed holds the one prefill slot: w3 keeps its link, nothing replaces w2's seed.
    expect(setLauncherPrefill).toHaveBeenCalledTimes(1);
    expect(useRunsStore.getState().launcherPrefill).toEqual(expect.objectContaining({ workspaceId: "w2" }));
    expect(mockIpc.clearWorkspacePrerequisite).toHaveBeenCalledWith("w2");
    expect(mockIpc.clearWorkspacePrerequisite).not.toHaveBeenCalledWith("w3");
    expect(usePrerequisitesStore.getState().byWs.w3).toEqual(link({ workspaceId: "w3" }));
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "w2 is ready to start" }));

    // w2's launcher took its seed: the next check stages w3.
    useRunsStore.setState({ launcherPrefill: null });
    await usePrerequisitesStore.getState().check();
    expect(useRunsStore.getState().launcherPrefill).toEqual(expect.objectContaining({ workspaceId: "w3", task: "Write the guide" }));
    expect(usePrerequisitesStore.getState().byWs).toEqual({});
    expect(pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "w3 is ready to start" }));
  });

  it("doesn't claim a seed for a refused auto-start while another mission's seed holds the slot", async () => {
    useRunsStore.setState({ launcherPrefill: { task: "x", pipelineId: "p", overrides: [], workspaceId: "w1" } });
    mockIpc.listRuns.mockResolvedValue([run("completed")]);
    begin.mockResolvedValue(undefined);
    await load([link({ autoStart: true })]);

    expect(begin).toHaveBeenCalled();
    expect(setLauncherPrefill).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "w2 is ready to start", body: expect.stringContaining("didn't start on its own"),
    }));
  });

  it("keeps waiting on a pr_merged prerequisite with no worktree of its own", async () => {
    useWorkspaceStore.setState({
      workspacesByProjectId: { p1: [{ ...workspace("w1"), worktreePath: null }, workspace("w2", "Wire the token store")] },
    });
    mockIpc.findPrForBranch.mockResolvedValue(pr("merged"));
    await load([link({ afterCondition: "pr_merged" })]);

    expect(mockIpc.findPrForBranch).not.toHaveBeenCalled();
    expect(mockIpc.clearWorkspacePrerequisite).not.toHaveBeenCalled();
    expect(usePrerequisitesStore.getState().byWs.w2).toBeDefined();
  });

  it("clear resolves to whether the link was cleared", async () => {
    mockIpc.listRuns.mockResolvedValue([]);
    await load([link()]);

    mockIpc.clearWorkspacePrerequisite.mockRejectedValueOnce("other: The database is busy.");
    expect(await usePrerequisitesStore.getState().clear("w2")).toBe(false);
    expect(usePrerequisitesStore.getState().byWs.w2).toBeDefined();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "The database is busy." }));

    expect(await usePrerequisitesStore.getState().clear("w2")).toBe(true);
    expect(usePrerequisitesStore.getState().byWs.w2).toBeUndefined();
  });
});

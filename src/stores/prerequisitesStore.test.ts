/**
 * prerequisitesStore ("Starts after", #960 slice 2): a met link is cleared and
 * its mission's start offered once (staged, or begun with auto-start); a
 * stopped prerequisite run keeps the mission waiting and says why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prerequisite, Run, RunStage } from "../lib/ipc";
import type { Workspace } from "../lib/types";

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
  return { useRunsStore: create(() => ({ activeRunIdByWs: {} as Record<string, string | null>, begin, setLauncherPrefill, selectRun })) };
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
  useRunsStore.setState({ activeRunIdByWs: {} });
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
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }));
vi.mock("../components/Toasts", () => ({ pushToast: pushToastMock }));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../lib/ipc");
  return {
    ...actual,
    ipc: {
      listRuns: vi.fn(),
      getRun: vi.fn(),
      createRun: vi.fn(),
      startRun: vi.fn(),
      resolveCheckpoint: vi.fn(),
      abortRun: vi.fn(),
      stopStage: vi.fn(),
      updateRunStage: vi.fn(),
      rerunFromStage: vi.fn(),
    },
  };
});

import { ipc, type Run, type RunStage } from "../lib/ipc";
import { useRunsStore, EMPTY_RUNS } from "./runsStore";

const RUN: Run = {
  id: "r1", workspaceId: "w1", pipelineId: "p1", task: "t", status: "running",
  costUsd: 0.05, baselineUsd: 0.2, referenceModel: "m", linkedIssueKey: null,
  createdAt: "t", finishedAt: null, budgetUsd: null,
  detached: false,
};
const STAGE: RunStage = {
  id: "st1", runId: "r1", position: 0, role: "plan", agentModel: "m", substrate: "api",
  checkpoint: false, status: "running", inputTokens: 0, outputTokens: 0, costUsd: 0,
  artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
  diffSnapshot: null, parents: [], tools: null, customName: null, instructions: null,
  sessionId: null, baselineCommit: null, escalated: false,
};

describe("runsStore", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: {}, loadedByWs: {}, activeRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
      selectedRunIdByWs: {}, liveByStage: {}, settledAt: {}, statusSince: {},
    });
    vi.clearAllMocks();
  });

  it("appendEntry accumulates structured entries per stage and caps the buffer", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "first" });
    s.appendEntry("st1", { kind: "tool", tool: "Edit", hint: "src/x.rs" });
    const e = useRunsStore.getState().getLiveEntries("st1");
    expect(e).toEqual([
      { kind: "text", text: "first" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
    ]);
    // a different stage keeps its own buffer
    s.appendEntry("st2", { kind: "notice", text: "other" });
    expect(useRunsStore.getState().getLiveEntries("st2")).toHaveLength(1);
    // bounded to the most recent 200
    for (let i = 0; i < 250; i++) useRunsStore.getState().appendEntry("st1", { kind: "text", text: `L${i}` });
    const capped = useRunsStore.getState().getLiveEntries("st1");
    expect(capped.length).toBe(200);
    expect(capped[capped.length - 1]).toEqual({ kind: "text", text: "L249" });
  });

  it("clearLog drops a stage's buffer so a re-run starts fresh", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "old" });
    s.clearLog("st1");
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([]);
  });

  it("hydrateLog fills an empty stage buffer from the persisted log", () => {
    useRunsStore.getState().hydrateLog("st1", [
      { kind: "text", text: "restored" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
    ]);
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([
      { kind: "text", text: "restored" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
    ]);
  });

  it("hydrateLog never clobbers a non-empty (live) buffer", () => {
    useRunsStore.getState().appendEntry("st1", { kind: "text", text: "live" });
    useRunsStore.getState().hydrateLog("st1", [{ kind: "text", text: "stale" }]);
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([
      { kind: "text", text: "live" },
    ]);
  });

  it("getRuns returns the stable empty default for an unknown workspace", () => {
    expect(useRunsStore.getState().getRuns("nope")).toBe(EMPTY_RUNS);
  });

  it("loadRuns populates runs and picks the active (non-terminal) run", async () => {
    (ipc.listRuns as any).mockResolvedValue([RUN]);
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [STAGE] });
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().getRuns("w1")).toHaveLength(1);
    expect(useRunsStore.getState().getActiveRunId("w1")).toBe("r1");
    expect(useRunsStore.getState().getDetail("r1")?.stages).toHaveLength(1);
  });

  it("loadRuns is safe to call repeatedly and picks up a run staged externally (e.g. via octopush-mcp)", async () => {
    (ipc.listRuns as any).mockResolvedValue([RUN]);
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [STAGE] });
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().getRuns("w1")).toHaveLength(1);

    // A focus-driven refresh must not disturb any live log buffer already
    // streaming for this workspace's stages.
    useRunsStore.getState().appendEntry("st1", { kind: "text", text: "live" });

    const DRAFT: Run = { ...RUN, id: "r2", status: "draft" };
    (ipc.listRuns as any).mockResolvedValue([RUN, DRAFT]);
    await useRunsStore.getState().loadRuns("w1");

    expect(useRunsStore.getState().getRuns("w1").map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([{ kind: "text", text: "live" }]);
  });

  it("applyStageUpdate replaces the run row in detail and runs list", () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] },
      activeRunIdByWs: { w1: "r1" },
      detailByRun: { r1: { run: RUN, stages: [STAGE] } },
      selectedStageByRun: {},
    });
    const updated: Run = { ...RUN, status: "paused" as const, costUsd: 0.09 };
    useRunsStore.getState().applyStageUpdate("r1", updated);
    expect(useRunsStore.getState().getDetail("r1")?.run?.status).toBe("paused");
    expect(useRunsStore.getState().getRuns("w1")[0].costUsd).toBe(0.09);
  });

  it("applyCost updates the active run's cost/baseline", () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" },
      detailByRun: { r1: { run: RUN, stages: [STAGE] } }, selectedStageByRun: {},
    });
    useRunsStore.getState().applyCost("r1", 0.12, 0.4);
    const d = useRunsStore.getState().getDetail("r1");
    expect(d?.run?.costUsd).toBe(0.12);
    expect(d?.run?.baselineUsd).toBe(0.4);
  });

  it("applyCost without a detail entry still updates the run row in runsByWs", () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" },
      detailByRun: {}, selectedStageByRun: {}, // run listed but never opened
    });
    useRunsStore.getState().applyCost("r1", 0.12, 0.4);
    const row = useRunsStore.getState().getRuns("w1")[0];
    expect(row.costUsd).toBe(0.12);
    expect(row.baselineUsd).toBe(0.4);
    // No phantom detail entry was invented.
    expect(useRunsStore.getState().getDetail("r1")).toBeUndefined();
  });

  it("applyCost for an unknown run is a no-op", () => {
    useRunsStore.setState({ runsByWs: { w1: [RUN] }, detailByRun: {} });
    useRunsStore.getState().applyCost("ghost", 9, 9);
    expect(useRunsStore.getState().getRuns("w1")[0].costUsd).toBe(0.05);
  });

  it("loadRuns marks the workspace as loaded", async () => {
    (ipc.listRuns as any).mockResolvedValue([]);
    expect((useRunsStore.getState() as any).loadedByWs["w1"]).toBeUndefined();
    await useRunsStore.getState().loadRuns("w1");
    expect((useRunsStore.getState() as any).loadedByWs["w1"]).toBe(true);
  });

  it("refreshDetail also syncs the run into runsByWs", async () => {
    const updated = { ...RUN, status: "completed", costUsd: 0.3 };
    (ipc.getRun as any).mockResolvedValue({ run: updated, stages: [STAGE] });
    // Seed an existing list entry with the old run.
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" },
      detailByRun: {}, selectedStageByRun: {},
    });
    await useRunsStore.getState().refreshDetail("r1");
    expect(useRunsStore.getState().getDetail("r1")?.run?.status).toBe("completed");
    // The list entry must be updated too (not stale).
    expect(useRunsStore.getState().getRuns("w1")[0].status).toBe("completed");
    expect(useRunsStore.getState().getRuns("w1")).toHaveLength(1);
  });

  it("getViewedRunId defaults to the active run, honors an explicit selection, and null = launcher", () => {
    useRunsStore.setState({ activeRunIdByWs: { w1: "rActive" }, selectedRunIdByWs: {} });
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rActive"); // default → active
    useRunsStore.getState().selectRun("w1", "rOther");
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rOther");  // explicit run
    useRunsStore.getState().selectRun("w1", null);
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe(null);      // launcher
  });

  it("hasExecutingRun is true only when a run in the workspace is running or paused", () => {
    const mk = (id: string, status: import("../lib/ipc").RunStatus) => ({ id, workspaceId: "w1", pipelineId: "p", task: "t",
      status, costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, budgetUsd: null, detached: false });
    useRunsStore.setState({ runsByWs: { w1: [mk("r1", "completed")] } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(false); // terminal → false
    useRunsStore.setState({ runsByWs: { w1: [mk("r1", "draft")] } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(false); // draft does NOT count
    useRunsStore.setState({ runsByWs: { w1: [mk("r1", "paused")] } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(true);  // paused counts
    useRunsStore.setState({ runsByWs: { w1: [mk("r1", "running")] } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(true);
  });

  it("begin auto-selects the newly created run for viewing", async () => {
    (ipc.createRun as any).mockResolvedValue("rNew");
    (ipc.startRun as any).mockResolvedValue(undefined);
    (ipc.listRuns as any).mockResolvedValue([
      { id: "rNew", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
        costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, budgetUsd: null, detached: false },
    ]);
    await useRunsStore.getState().begin("w1", "p", "t", []);
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rNew");
  });

  it("begin threads budgetUsd through to startRun", async () => {
    (ipc.createRun as any).mockResolvedValue("rNew");
    (ipc.startRun as any).mockResolvedValue(undefined);
    (ipc.listRuns as any).mockResolvedValue([]);
    await useRunsStore.getState().begin("w1", "p", "t", [], undefined, 2.5);
    expect(ipc.startRun).toHaveBeenCalledWith("rNew", 2.5);
  });

  it("begin passes a null budget when none is given", async () => {
    (ipc.createRun as any).mockResolvedValue("rNew");
    (ipc.startRun as any).mockResolvedValue(undefined);
    (ipc.listRuns as any).mockResolvedValue([]);
    await useRunsStore.getState().begin("w1", "p", "t", []);
    expect(ipc.startRun).toHaveBeenCalledWith("rNew", null);
  });

  it("launcherPrefill is consumed exactly once (R3)", () => {
    const prefill = { task: "again", pipelineId: "p1", overrides: [[0, "m"]] as [number, string][] };
    useRunsStore.getState().setLauncherPrefill(prefill);
    expect(useRunsStore.getState().launcherPrefill).toEqual(prefill);
    expect(useRunsStore.getState().consumeLauncherPrefill()).toEqual(prefill);
    expect(useRunsStore.getState().launcherPrefill).toBeNull();
    expect(useRunsStore.getState().consumeLauncherPrefill()).toBeNull();
  });

  it("stopStage fires the stop_stage IPC for the run (R2)", async () => {
    (ipc.stopStage as any).mockResolvedValue(undefined);
    await useRunsStore.getState().stopStage("r1");
    expect(ipc.stopStage).toHaveBeenCalledWith("r1");
  });

  it("begin aborts the draft and does not select it when startRun is rejected", async () => {
    (ipc.createRun as any).mockResolvedValue("rDraft");
    (ipc.startRun as any).mockRejectedValue(new Error("another run is already in progress"));
    (ipc.abortRun as any) = (ipc.abortRun as any) ?? vi.fn();
    (ipc.abortRun as any).mockResolvedValue(undefined);
    await useRunsStore.getState().begin("w1", "p", "t", []).catch(() => {});
    expect(ipc.abortRun).toHaveBeenCalledWith("rDraft");
    // no explicit selection of the dead draft
    expect("w1" in (useRunsStore.getState() as any).selectedRunIdByWs).toBe(false);
  });

  it("updateStage patches the stage optimistically before the IPC call resolves", async () => {
    useRunsStore.setState({ detailByRun: { r1: { run: RUN, stages: [STAGE] } } });
    let resolveIpc: () => void = () => {};
    (ipc.updateRunStage as any).mockImplementation(
      () => new Promise<void>((resolve) => { resolveIpc = resolve; }),
    );
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [{ ...STAGE, checkpoint: true }] });

    const pending = useRunsStore.getState().updateStage("r1", "st1", { checkpoint: true });
    // The optimistic patch lands synchronously, ahead of the IPC round trip.
    expect(useRunsStore.getState().getDetail("r1")?.stages[0].checkpoint).toBe(true);

    resolveIpc();
    await pending;
    expect(ipc.updateRunStage).toHaveBeenCalledWith("r1", "st1", { checkpoint: true });
    expect(useRunsStore.getState().getDetail("r1")?.stages[0].checkpoint).toBe(true);
  });

  it("updateStage reverts the optimistic patch when the backend rejects the edit", async () => {
    useRunsStore.setState({ detailByRun: { r1: { run: RUN, stages: [STAGE] } } }); // STAGE.checkpoint === false
    (ipc.updateRunStage as any).mockRejectedValue(new Error("stage already started"));
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [STAGE] }); // truth: unchanged

    await expect(
      useRunsStore.getState().updateStage("r1", "st1", { checkpoint: true }),
    ).rejects.toThrow("stage already started");

    // refreshDetail ran in `finally` and snapped the optimistic flip back to truth.
    expect(useRunsStore.getState().getDetail("r1")?.stages[0].checkpoint).toBe(false);
  });

  it("rerunFromStage calls the IPC then refreshes detail", async () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, detailByRun: { r1: { run: RUN, stages: [STAGE] } },
    });
    (ipc.rerunFromStage as any).mockResolvedValue(undefined);
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, status: "running" }, stages: [STAGE] });

    await useRunsStore.getState().rerunFromStage("r1", "st1");
    expect(ipc.rerunFromStage).toHaveBeenCalledWith("r1", "st1", undefined);
    expect(useRunsStore.getState().getDetail("r1")?.run?.status).toBe("running");
  });

  it("rerunFromStage forwards the director's patch to the IPC", async () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, detailByRun: { r1: { run: RUN, stages: [STAGE] } },
    });
    (ipc.rerunFromStage as any).mockResolvedValue(undefined);
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, status: "running" }, stages: [STAGE] });

    await useRunsStore.getState().rerunFromStage("r1", "st1", {
      instructions: "tightened brief", agentModel: "claude-sonnet-5", checkpoint: true,
    });
    expect(ipc.rerunFromStage).toHaveBeenCalledWith("r1", "st1", {
      instructions: "tightened brief", agentModel: "claude-sonnet-5", checkpoint: true,
    });
  });

  it("rerunFromStage still refreshes detail (and rethrows) when the backend rejects", async () => {
    useRunsStore.setState({ detailByRun: {} });
    (ipc.rerunFromStage as any).mockRejectedValue(new Error("this run is executing"));
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [STAGE] });

    await expect(
      useRunsStore.getState().rerunFromStage("r1", "st1"),
    ).rejects.toThrow("this run is executing");
    expect(ipc.getRun).toHaveBeenCalledWith("r1");
  });

  // ── Staged (draft) runs — e.g. authored by octopush-mcp ──

  it("start launches a staged draft and refreshes its detail", async () => {
    (ipc.startRun as any).mockResolvedValue(undefined);
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, status: "running" }, stages: [] });
    await useRunsStore.getState().start("r1");
    expect(ipc.startRun).toHaveBeenCalledWith("r1", null);
    expect(ipc.getRun).toHaveBeenCalledWith("r1");
  });

  it("start over the quota gate shows the upgrade sheet and LEAVES the draft intact", async () => {
    // Unlike begin() (which aborts its own just-created orphan), a staged
    // draft is prior user data — a refused start must never destroy it.
    const { useUpgradeStore } = await import("./upgradeStore");
    useUpgradeStore.setState({ info: null });
    (ipc.startRun as any).mockRejectedValue(
      JSON.stringify({ kind: "UpgradeRequired", feature: "direct.unlimited", used: 25, limit: 25 }),
    );

    await useRunsStore.getState().start("r1");

    expect(useUpgradeStore.getState().info?.feature).toBe("direct.unlimited");
    expect(ipc.abortRun).not.toHaveBeenCalled();
  });

  it("start surfaces a non-upgrade failure as a toast (the CTA must never look dead)", async () => {
    (ipc.startRun as any).mockRejectedValue(new Error("engine on fire"));
    await expect(useRunsStore.getState().start("r1")).resolves.toBeUndefined();
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Couldn't start the run" }),
    );
  });

  it("start guards against a double-click double-start", async () => {
    let release!: () => void;
    (ipc.startRun as any).mockImplementation(
      () => new Promise<void>((res) => { release = res; }),
    );
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, status: "running" }, stages: [] });
    const first = useRunsStore.getState().start("r1");
    const second = useRunsStore.getState().start("r1"); // while the first is in flight
    release();
    await Promise.all([first, second]);
    expect(ipc.startRun).toHaveBeenCalledTimes(1);
  });

  // ── Background (focus) refresh: sticky active, never clobber the canvas ──

  it("background loadRuns keeps the current active run in place", async () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, // r1 running
      activeRunIdByWs: { w1: "r1" },
    });
    // An MCP-staged draft appears, newer than the running run.
    const draft: Run = { ...RUN, id: "rDraft", status: "draft" };
    (ipc.listRuns as any).mockResolvedValue([draft, RUN]);
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [] });
    await useRunsStore.getState().loadRuns("w1", { background: true });
    expect(useRunsStore.getState().getActiveRunId("w1")).toBe("r1");
    // …but the draft IS in the list (Companion RUNS shows it).
    expect(useRunsStore.getState().getRuns("w1").some((r) => r.id === "rDraft")).toBe(true);
  });

  it("background loadRuns never lets a staged draft steal the launcher", async () => {
    // User is composing on the launcher (no active run); MCP stages a draft.
    useRunsStore.setState({ runsByWs: { w1: [] }, activeRunIdByWs: { w1: null } });
    (ipc.listRuns as any).mockResolvedValue([{ ...RUN, id: "rDraft", status: "draft" }]);
    await useRunsStore.getState().loadRuns("w1", { background: true });
    expect(useRunsStore.getState().getActiveRunId("w1")).toBeNull();
  });

  it("background loadRuns adopts an executing run when the active one is gone", async () => {
    useRunsStore.setState({ runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" } });
    const other: Run = { ...RUN, id: "r2", status: "paused" };
    (ipc.listRuns as any).mockResolvedValue([{ ...RUN, status: "completed" }, other]);
    (ipc.getRun as any).mockResolvedValue({ run: other, stages: [] });
    await useRunsStore.getState().loadRuns("w1", { background: true });
    expect(useRunsStore.getState().getActiveRunId("w1")).toBe("r2");
  });

  it("foreground loadRuns still presents a staged draft (first load / ws switch)", async () => {
    (ipc.listRuns as any).mockResolvedValue([{ ...RUN, id: "rDraft", status: "draft" }]);
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, id: "rDraft", status: "draft" }, stages: [] });
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().getActiveRunId("w1")).toBe("rDraft");
  });

  // ── Mission Control board tracking (settled band + time-in-state) ──

  it("applyStageUpdate stamps statusSince on a status change and settles an active→terminal run", () => {
    useRunsStore.setState({ runsByWs: { w1: [RUN] } }); // RUN is running
    useRunsStore.getState().applyStageUpdate("r1", { ...RUN, status: "paused" });
    const s1 = useRunsStore.getState();
    expect(s1.statusSince["r1"]).toBeTypeOf("number");
    expect(s1.settledAt["r1"]).toBeUndefined(); // paused is not terminal

    useRunsStore.getState().applyStageUpdate("r1", { ...RUN, status: "completed" });
    const s2 = useRunsStore.getState();
    expect(s2.settledAt["r1"]).toBeTypeOf("number"); // active → terminal lands on the board
  });

  it("applyStageUpdate does not settle a run that was never seen active", () => {
    // e.g. a draft aborted by the failed-start cleanup, or a first-ever event
    // that already arrives terminal for a row we never held as active.
    useRunsStore.setState({ runsByWs: { w1: [{ ...RUN, status: "draft" as const }] } });
    useRunsStore.getState().applyStageUpdate("r1", { ...RUN, status: "aborted" });
    expect(useRunsStore.getState().settledAt["r1"]).toBeUndefined();
  });

  it("applyStageUpdate with an unchanged status stamps nothing", () => {
    useRunsStore.setState({ runsByWs: { w1: [RUN] } });
    useRunsStore.getState().applyStageUpdate("r1", { ...RUN, costUsd: 0.2 });
    expect(useRunsStore.getState().statusSince["r1"]).toBeUndefined();
  });

  it("dismissSettled and clearSettled clear the board (session-local)", () => {
    useRunsStore.setState({ settledAt: { r1: 1, r2: 2 } });
    useRunsStore.getState().dismissSettled("r1");
    expect(useRunsStore.getState().settledAt).toEqual({ r2: 2 });
    useRunsStore.getState().clearSettled();
    expect(useRunsStore.getState().settledAt).toEqual({});
  });

  it("refreshDetail also settles an active→terminal transition (no race with events)", async () => {
    // A run completes while a refreshDetail is in flight: getRun returns the
    // already-terminal row. The transition tracker must fire on THIS write
    // path too, or the later run:// event sees no change and the run silently
    // vanishes from the board.
    useRunsStore.setState({ runsByWs: { w1: [RUN] } }); // running
    (ipc.getRun as any).mockResolvedValue({ run: { ...RUN, status: "completed" }, stages: [] });
    await useRunsStore.getState().refreshDetail("r1");
    expect(useRunsStore.getState().settledAt["r1"]).toBeTypeOf("number");
  });

  it("loadRuns settles an active→terminal transition seen via the list", async () => {
    useRunsStore.setState({ runsByWs: { w1: [RUN] } }); // running
    (ipc.listRuns as any).mockResolvedValue([{ ...RUN, status: "aborted" }]);
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().settledAt["r1"]).toBeTypeOf("number");
  });

  it("loadRuns first sight of terminal history rows stamps nothing", async () => {
    // Bulk-loading a workspace's run history must not reset time-in-state or
    // put old completed runs on the board.
    (ipc.listRuns as any).mockResolvedValue([{ ...RUN, status: "completed" }]);
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().settledAt["r1"]).toBeUndefined();
    expect(useRunsStore.getState().statusSince["r1"]).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }));
vi.mock("../components/Toasts", () => ({ pushToast: pushToastMock }));

import { commentTarget, forgetPendingGateSends, sendBackMessage, sendReviewComments } from "./sendReviewComments";
import { labelForRole } from "./stageMeta";
import { useReviewComments } from "../stores/reviewCommentsStore";
import { useGateCommentsStore } from "../stores/gateCommentsStore";
import { useRunsStore } from "../stores/runsStore";
import { useChatStore } from "../stores/chatStore";
import { NAVIGATE_EVENT } from "./tour/surfaces";
import type { Run, RunStage } from "./ipc";

const note = { filePath: "a.ts", fingerprint: "f1", startLine: 2, endLine: 2, quote: ["+x"], note: "Rename x." };

const stage = (over: Partial<RunStage>): RunStage =>
  ({ id: "s", position: 0, role: "implementer", status: "done", startedAt: "t", artifact: null,
    loopMode: null, loopTargetPosition: null, loopIterations: 0, loopMaxIterations: 3, ...over }) as RunStage;
const parked = (over: Partial<RunStage> = {}, status = "paused", listed = status) => {
  const run = { id: "r1", workspaceId: "w1", status } as Run;
  useRunsStore.setState({
    runsByWs: { w1: [{ ...run, status: listed } as Run] },
    detailByRun: {
      r1: {
        run,
        stages: [
          stage({ id: "impl", position: 0 }),
          stage({ id: "rev", position: 1, role: "reviewer", status: "awaiting_checkpoint", loopMode: "gated", loopTargetPosition: 0, ...over }),
        ],
      },
    },
  });
};

describe("sendReviewComments", () => {
  // Like the real `send`: reports dispatch, then resolves when the turn ended.
  const send = vi.fn(async (...args: unknown[]) => {
    (args[4] as { onDispatched?: () => void } | undefined)?.onDispatched?.();
    return true;
  });
  const resolve = vi.fn(async (..._args: unknown[]) => true);
  const modes: string[] = [];
  const onNav = (e: Event) => modes.push((e as CustomEvent).detail.mode);

  beforeEach(() => {
    send.mockClear();
    resolve.mockClear();
    modes.length = 0;
    window.removeEventListener(NAVIGATE_EVENT, onNav);
    window.addEventListener(NAVIGATE_EVENT, onNav);
    useReviewComments.setState({ byWs: {}, liveByWs: {} });
    useGateCommentsStore.setState({ byGate: {} });
    pushToastMock.mockClear();
    forgetPendingGateSends();
    useRunsStore.setState({ runsByWs: {}, detailByRun: {}, runErrors: {}, resolve });
    useChatStore.setState({ send });
  });

  it("sends to the open Talk thread when no run waits at a gate, and empties the tray", async () => {
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    // Without Talk's staged attachments: the message is the comments only.
    expect(send).toHaveBeenCalledWith("w1", "/w1", expect.stringContaining("> +x\n\nRename x."), undefined, { attachments: false, onDispatched: expect.any(Function) });
    expect(resolve).not.toHaveBeenCalled();
    expect(modes).toEqual(["talk"]);
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
  });

  it("keeps the comments when Talk doesn't send the turn (budget cap, no thread, IPC error)", async () => {
    send.mockResolvedValueOnce(false);
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(useReviewComments.getState().byWs.w1).toEqual([expect.objectContaining({ note: "Rename x." })]);
  });

  it("keeps the comments when the gate refuses the send-back", async () => {
    parked();
    resolve.mockResolvedValueOnce(false);
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(useReviewComments.getState().byWs.w1).toEqual([expect.objectContaining({ note: "Rename x." })]);
  });

  it("keeps the comments when the send throws, ahead of any added meanwhile", async () => {
    send.mockImplementationOnce(async () => {
      useReviewComments.getState().add("w1", { ...note, note: "Later." });
      throw new Error("ipc down");
    });
    useReviewComments.getState().add("w1", note);
    await expect(sendReviewComments("w1", "/w1")).rejects.toThrow("ipc down");
    expect(useReviewComments.getState().byWs.w1.map((c) => c.note)).toEqual(["Rename x.", "Later."]);
  });

  it("sends back the latest run's gate with the comments as its feedback", async () => {
    parked();
    expect(commentTarget("w1")).toEqual({
      kind: "gate", runId: "r1", stageId: "rev", gate: "rev:", gateRole: labelForRole("reviewer"), role: labelForRole("implementer"), iteration: 0,
    });
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(resolve).toHaveBeenCalledWith("r1", "rev", "send_back", { feedback: expect.stringContaining("Rename x.") });
    expect(send).not.toHaveBeenCalled();
    expect(modes).toEqual(["direct"]);
  });

  it("carries the gate's inline comments in the same message, and clears them once applied (#1051)", async () => {
    parked();
    useGateCommentsStore.getState().add("rev:", "Step two", "Too vague.", 10, 8);
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(resolve).toHaveBeenCalledTimes(1);
    const feedback = (resolve.mock.calls[0][3] as { feedback: string }).feedback;
    expect(feedback).toContain("Rename x.");
    expect(feedback).toContain(`On ${labelForRole("reviewer")}'s output at the gate:`);
    expect(feedback).toContain('1. On "Step two":\n   Too vague.');
    expect(feedback.indexOf("Rename x.")).toBeLessThan(feedback.indexOf("Too vague."));
    // Accepted, not yet applied: the gate keeps them.
    expect(useGateCommentsStore.getState().byGate["rev:"]).toHaveLength(1);
    parked({ status: "pending", loopIterations: 1 });
    expect(useGateCommentsStore.getState().byGate["rev:"]).toBeUndefined();
  });

  it("leaves the gate's comments on the gate when the send-back is refused", async () => {
    parked();
    useGateCommentsStore.getState().add("rev:", "Step two", "Too vague.", 10, 8);
    useReviewComments.getState().add("w1", note);
    resolve.mockResolvedValueOnce(false);
    await sendReviewComments("w1", "/w1");
    expect(useGateCommentsStore.getState().byGate["rev:"]).toHaveLength(1);

    await sendReviewComments("w1", "/w1");
    useRunsStore.getState().noteRunError("r1", "run is already executing");
    expect(useGateCommentsStore.getState().byGate["rev:"]).toHaveLength(1);
    expect(useReviewComments.getState().byWs.w1).toHaveLength(1);
  });

  it("sends only the tray's comments when the gate has none", () => {
    expect(sendBackMessage("review", [], "Reviewer")).toBe("review");
  });

  it("falls back to Talk once the gate's loop is at its cap", () => {
    parked({ loopIterations: 3 });
    expect(commentTarget("w1")).toEqual({ kind: "talk" });
  });

  // An abort leaves the parked stage at `awaiting_checkpoint`: a send-back
  // there would archive stages and reach no agent.
  it.each(["aborted", "completed", "failed"])("goes to Talk, not to the gate, when the run is %s", async (status) => {
    parked({}, status);
    expect(commentTarget("w1")).toEqual({ kind: "talk" });
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(resolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(modes).toEqual(["talk"]);
  });

  it("reads the run's end from the detail too, when the list is behind", () => {
    parked({}, "aborted", "paused");
    expect(commentTarget("w1")).toEqual({ kind: "talk" });
  });

  it("switches mode only once the send went out: Talk on dispatch, Direct on an accepted send-back", async () => {
    const seen: string[][] = [];
    send.mockImplementationOnce(async (...args: unknown[]) => {
      seen.push([...modes]);
      (args[4] as { onDispatched: () => void }).onDispatched();
      return true;
    });
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(seen).toEqual([[]]);
    expect(modes).toEqual(["talk"]);

    parked();
    resolve.mockImplementationOnce(async () => { seen.push([...modes]); return true; });
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(seen[1]).toEqual(["talk"]);
    expect(modes).toEqual(["talk", "direct"]);
  });

  it("stays in Review when the send didn't go out", async () => {
    send.mockResolvedValueOnce(false);
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    parked();
    resolve.mockResolvedValueOnce(false);
    await sendReviewComments("w1", "/w1");
    expect(modes).toEqual([]);
  });

  // Without detached runs the backend applies the decision in the background:
  // the dispatch succeeds and a refusal arrives later as `run://error`.
  it("puts the comments back when the run refuses the send-back after accepting it", async () => {
    parked();
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
    useReviewComments.getState().add("w1", { ...note, note: "Later." });
    // Something else in the store changing settles nothing.
    useRunsStore.setState({ selectedStageByRun: {} });
    expect(useReviewComments.getState().byWs.w1.map((c) => c.note)).toEqual(["Later."]);

    useRunsStore.getState().noteRunError("r1", "run is already executing");
    expect(useReviewComments.getState().byWs.w1.map((c) => c.note)).toEqual(["Rename x.", "Later."]);
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Comments not sent",
      body: "run is already executing. They are back in Review's tray.",
    }));
    // Settled: a second error doesn't restore them twice.
    useRunsStore.getState().noteRunError("r1", "again");
    expect(useReviewComments.getState().byWs.w1).toHaveLength(2);
  });

  it("leaves the tray empty once the gate's stage moved, whatever fails later", async () => {
    parked();
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    // Applied: the loop went back, the review stage waits for its turn again.
    parked({ status: "pending", loopIterations: 1 });
    useRunsStore.getState().noteRunError("r1", "the next stage failed to start");
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
    expect(pushToastMock).not.toHaveBeenCalled();
  });

  it("an error from before the send is not taken for its refusal", async () => {
    parked();
    useRunsStore.getState().noteRunError("r1", "old");
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    useRunsStore.setState({ selectedStageByRun: {} });
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
  });

  it("does nothing with an empty tray", async () => {
    await sendReviewComments("w1", "/w1");
    expect(send).not.toHaveBeenCalled();
    expect(modes).toEqual([]);
  });
});

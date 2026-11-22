import { describe, it, expect, vi, beforeEach } from "vitest";
import { commentTarget, sendReviewComments } from "./sendReviewComments";
import { useReviewComments } from "../stores/reviewCommentsStore";
import { useRunsStore } from "../stores/runsStore";
import { useChatStore } from "../stores/chatStore";
import { NAVIGATE_EVENT } from "./tour/surfaces";
import type { Run, RunStage } from "./ipc";

const note = { filePath: "a.ts", fingerprint: "f1", startLine: 2, endLine: 2, quote: ["+x"], note: "Rename x." };

const stage = (over: Partial<RunStage>): RunStage =>
  ({ id: "s", position: 0, role: "implementer", status: "done", startedAt: "t", artifact: null,
    loopMode: null, loopTargetPosition: null, loopIterations: 0, loopMaxIterations: 3, ...over }) as RunStage;
const parked = (over: Partial<RunStage> = {}) => {
  const run = { id: "r1", workspaceId: "w1", status: "paused" } as Run;
  useRunsStore.setState({
    runsByWs: { w1: [run] },
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
  const send = vi.fn(async () => {});
  const resolve = vi.fn(async () => {});
  const modes: string[] = [];
  const onNav = (e: Event) => modes.push((e as CustomEvent).detail.mode);

  beforeEach(() => {
    send.mockClear();
    resolve.mockClear();
    modes.length = 0;
    window.removeEventListener(NAVIGATE_EVENT, onNav);
    window.addEventListener(NAVIGATE_EVENT, onNav);
    useReviewComments.setState({ byWs: {}, liveByWs: {} });
    useRunsStore.setState({ runsByWs: {}, detailByRun: {}, resolve });
    useChatStore.setState({ send });
  });

  it("sends to the open Talk thread when no run waits at a gate, and empties the tray", async () => {
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(send).toHaveBeenCalledWith("w1", "/w1", expect.stringContaining("> +x\n\nRename x."));
    expect(resolve).not.toHaveBeenCalled();
    expect(modes).toEqual(["talk"]);
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
  });

  it("sends back the latest run's gate with the comments as its feedback", async () => {
    parked();
    expect(commentTarget("w1")).toEqual({ kind: "gate", runId: "r1", stageId: "rev", role: "implementer" });
    useReviewComments.getState().add("w1", note);
    await sendReviewComments("w1", "/w1");
    expect(resolve).toHaveBeenCalledWith("r1", "rev", "send_back", { feedback: expect.stringContaining("Rename x.") });
    expect(send).not.toHaveBeenCalled();
    expect(modes).toEqual(["direct"]);
  });

  it("falls back to Talk once the gate's loop is at its cap", () => {
    parked({ loopIterations: 3 });
    expect(commentTarget("w1")).toEqual({ kind: "talk" });
  });

  it("does nothing with an empty tray", async () => {
    await sendReviewComments("w1", "/w1");
    expect(send).not.toHaveBeenCalled();
    expect(modes).toEqual([]);
  });
});

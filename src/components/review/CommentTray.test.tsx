import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CommentTray } from "./CommentTray";
import { useReviewComments } from "../../stores/reviewCommentsStore";
import { useRunsStore } from "../../stores/runsStore";
import { useChatStore } from "../../stores/chatStore";
import { useGateCommentsStore } from "../../stores/gateCommentsStore";
import { labelForRole } from "../../lib/stageMeta";
import type { Run, RunStage } from "../../lib/ipc";

const base = { filePath: "src/a.ts", startLine: 2, endLine: 3, quote: ["+one", "+two", "+three", "+four"], note: "Name these." };

describe("CommentTray", () => {
  const send = vi.fn(async () => true);
  beforeEach(() => {
    send.mockClear();
    useReviewComments.setState({ byWs: {}, liveByWs: { w1: new Set(["src/a.ts\nlive"]) } });
    useRunsStore.setState({ runsByWs: {}, detailByRun: {}, loadRuns: vi.fn(async () => {}) });
    useChatStore.setState({ send, streamingByWs: {} });
  });

  it("folds away while empty", () => {
    const { container } = render(<CommentTray workspaceId="w1" workspacePath="/w1" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("lists each comment with its place, quote and note, and marks an outdated one", () => {
    act(() => {
      useReviewComments.getState().add("w1", { ...base, fingerprint: "live" });
      useReviewComments.getState().add("w1", { ...base, fingerprint: "gone", note: "Old." });
    });
    const onJump = vi.fn();
    const { getAllByText, queryAllByText, getByText, getByRole, getAllByRole } = render(<CommentTray workspaceId="w1" workspacePath="/w1" onJump={onJump} />);
    expect(getByRole("heading").textContent).toBe("For the agent · 2");
    expect(getByText("2")).toHaveClass("octo-tabular");
    expect(getAllByText("outdated")).toHaveLength(1);
    expect(getAllByText("+three")).toHaveLength(2);
    expect(queryAllByText("+four")).toHaveLength(0);
    expect(getByText("in Talk")).toBeTruthy();
    fireEvent.click(getAllByRole("button", { name: "src/a.ts:2–3" })[0]);
    expect(onJump).toHaveBeenCalledWith("src/a.ts", 2);
  });

  it("says when the quote was capped, and jumps to the file for a comment on removed lines", () => {
    act(() => {
      useReviewComments.getState().add("w1", { ...base, fingerprint: "live", quoteCut: 30, removed: true });
    });
    const onJump = vi.fn();
    const { getByText, getByRole, container } = render(<CommentTray workspaceId="w1" workspacePath="/w1" onJump={onJump} />);
    expect(getByText("… 30 more lines not quoted")).toBeTruthy();
    expect(container.querySelectorAll("[data-quote-cut]")).toHaveLength(1);
    // Old-side numbers are not lines of the file on disk.
    fireEvent.click(getByRole("button", { name: "src/a.ts:2–3 (removed)" }));
    expect(onJump).toHaveBeenCalledWith("src/a.ts", null);
  });

  it("says the gate's own comments go along with a send-back (#1051)", () => {
    const run = { id: "r1", workspaceId: "w1", status: "paused" } as Run;
    const st = (over: Partial<RunStage>) =>
      ({ id: "s", position: 0, role: "implementer", status: "done", startedAt: "t", artifact: null, finishedAt: "f",
        loopMode: null, loopTargetPosition: null, loopIterations: 0, loopMaxIterations: 3, ...over }) as RunStage;
    useRunsStore.setState({
      runsByWs: { w1: [run] },
      detailByRun: { r1: { run, stages: [st({ id: "impl" }), st({ id: "rev", position: 1, role: "reviewer", status: "awaiting_checkpoint", loopMode: "gated", loopTargetPosition: 0 })] } },
    });
    useGateCommentsStore.setState({ byGate: {} });
    act(() => {
      useReviewComments.getState().add("w1", { ...base, fingerprint: "live" });
      useGateCommentsStore.getState().add("rev:f", "Step two", "Too vague.", 0, 8);
      useGateCommentsStore.getState().add("rev:f", "Step three", "Drop it.", 20, 10);
    });
    const { container } = render(<CommentTray workspaceId="w1" workspacePath="/w1" />);
    expect(container.querySelector('[data-tour="review-companion-gate-comments"]')?.textContent).toBe(`, with 2 comments on ${labelForRole("reviewer")}`);
  });

  it("Send to the agent delivers them; it waits while Talk is answering", async () => {
    act(() => useReviewComments.getState().add("w1", { ...base, fingerprint: "live" }));
    useChatStore.setState({ streamingByWs: { w1: true } });
    const { getByRole } = render(<CommentTray workspaceId="w1" workspacePath="/w1" />);
    const btn = getByRole("button", { name: "Send to the agent" });
    expect(btn).toBeDisabled();
    act(() => useChatStore.setState({ streamingByWs: { w1: false } }));
    await act(async () => { fireEvent.click(btn); });
    expect(send).toHaveBeenCalledWith("w1", "/w1", expect.stringContaining("Name these."), undefined, { attachments: false, onDispatched: expect.any(Function) });
    expect(useReviewComments.getState().byWs.w1).toEqual([]);
  });
});

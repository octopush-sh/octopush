import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunControlBar } from "./RunControlBar";
import type { Run, RunStage } from "../lib/ipc";

const run = (status: Run["status"]): Run => ({
  id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status,
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null,
  createdAt: "t", finishedAt: null, budgetUsd: null,
});

const stage = (over: Partial<RunStage>): RunStage => ({
  id: "s1", runId: "r1", position: 0, role: "code_review", agentModel: "m", substrate: "api",
  checkpoint: true, status: "awaiting_checkpoint", inputTokens: 0, outputTokens: 0, costUsd: 0,
  artifact: null, feedback: null, error: null, startedAt: "t", finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0,
  diffSnapshot: null, maxIterations: 25, parents: [], tools: null, customName: null, instructions: null,
  sessionId: null, baselineCommit: null,
  ...over,
});

const handlers = () => ({
  onPause: vi.fn(), onStopStage: vi.fn(), onAbort: vi.fn(), onApprove: vi.fn(),
  onReject: vi.fn(), onResume: vi.fn(), onDiscard: vi.fn(), onSendBack: vi.fn(), onRunAgain: vi.fn(),
});

describe("RunControlBar", () => {
  it("running: offers pause / stop / abort and wires them", () => {
    const h = handlers();
    render(<RunControlBar run={run("running")} blockedStage={null} loopTargetRole={null} loopState={null} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /Pause at the next stage/i }));
    fireEvent.click(screen.getByRole("button", { name: /Stop the current stage/i }));
    fireEvent.click(screen.getByRole("button", { name: /Abort the run/i }));
    expect(h.onPause).toHaveBeenCalled();
    expect(h.onStopStage).toHaveBeenCalled();
    expect(h.onAbort).toHaveBeenCalled();
  });

  it("terminal: offers Run it again", () => {
    const h = handlers();
    render(<RunControlBar run={run("completed")} blockedStage={null} loopTargetRole={null} loopState={null} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /Run it again/i }));
    expect(h.onRunAgain).toHaveBeenCalled();
  });

  it("checkpoint: approve, reject (with feedback), abort", async () => {
    const h = handlers();
    render(<RunControlBar run={run("paused")} blockedStage={stage({})} loopTargetRole={null} loopState={null} {...h} />);
    expect(screen.getByText(/checkpoint/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve & continue/i }));
    expect(h.onApprove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/i }));
    // The editor crossfades in (FadeSwap holds the old view ~120ms first).
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "fix the imports" } });
    fireEvent.click(screen.getByRole("button", { name: /Re-run the stage/i }));
    // Non-failed checkpoint reject must NOT pass a turn override (FIX 3).
    expect(h.onReject).toHaveBeenCalledWith("fix the imports", undefined);
  });

  it("checkpoint with a loop target: offers Send back and shows loop state", async () => {
    const h = handlers();
    render(
      <RunControlBar run={run("paused")} blockedStage={stage({ loopTargetPosition: 0, loopMaxIterations: 3, loopIterations: 1 })}
        loopTargetRole="Implement" loopState={{ iteration: 1, max: 3 }} {...h} />,
    );
    expect(screen.getByText(/review loop/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Send back to Implement/i }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "missed a case" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send back$/i }));
    expect(h.onSendBack).toHaveBeenCalledWith("missed a case");
  });

  it("hard failure (Option A): Re-run primary action, why panel reveals accept/discard", async () => {
    const h = handlers();
    render(<RunControlBar run={run("paused")} blockedStage={stage({ status: "failed", error: "compile error: missing semicolon" })}
      loopTargetRole={null} loopState={null} {...h} />);
    expect(screen.getByText(/stage halted/i)).toBeInTheDocument();
    // API substrate with no sessionId → primary action is Re-run · N turns (default 50).
    fireEvent.click(screen.getByRole("button", { name: /^Re-run · 50 turns$/i }));
    expect(h.onReject).toHaveBeenCalledWith("", 50);
    // Open the why panel to access Accept partial work.
    fireEvent.click(screen.getByRole("button", { name: /why this halted/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Accept partial work/i }));
    expect(h.onApprove).toHaveBeenCalled();
  });

  it("failed stage reject (via Re-run button in mode=reject): passes turns override", async () => {
    const h = handlers();
    // Use a CLI substrate with a sessionId so the secondary "Re-run" button is visible.
    render(<RunControlBar run={run("paused")}
      blockedStage={stage({ status: "failed", error: "compile error: missing semicolon", maxIterations: 25, substrate: "cli", sessionId: "abc123" })}
      loopTargetRole={null} loopState={null} {...h} />);
    // The secondary Re-run button opens the reject editor (only shown when canResume=true).
    fireEvent.click(screen.getByRole("button", { name: /^Re-run$/i }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "fix it" } });
    fireEvent.click(screen.getByRole("button", { name: /Re-run the stage/i }));
    // Failed stage — turns override (defaultTurns = 50 for maxIterations=25) must be passed.
    expect(h.onReject).toHaveBeenCalledWith("fix it", 50);
  });

  it("transient halt: offers Resume in amber, not accept/re-run", () => {
    const h = handlers();
    render(<RunControlBar run={run("paused")} blockedStage={stage({ status: "failed", error: "rate limit exceeded" })}
      loopTargetRole={null} loopState={null} {...h} />);
    expect(screen.getByText(/awaiting retry/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Resume the stage/i }));
    expect(h.onResume).toHaveBeenCalled();
  });
});

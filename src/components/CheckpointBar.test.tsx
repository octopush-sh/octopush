import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ─── No IPC mocks needed — CheckpointBar has no ipc calls ─────────────────────

// Dynamic import AFTER mocks are wired.
const { CheckpointBar } = await import("./CheckpointBar");

// ─── Shared fixture ───────────────────────────────────────────────────────────

function makeStage(overrides = {}) {
  return {
    id: "s1",
    runId: "r1",
    position: 1,
    role: "code_review",
    agentModel: "claude-opus-4-6",
    substrate: "api" as const,
    checkpoint: true,
    status: "awaiting_checkpoint" as const,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    artifact: null,
    feedback: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    loopTargetPosition: null,
    loopMaxIterations: 0,
    loopMode: null as null,
    loopIterations: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CheckpointBar", () => {
  it("renders Approve, Reject, Abort for a normal checkpoint (no loop)", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Approve/i)).toBeInTheDocument();
    expect(screen.getByText(/Reject/i)).toBeInTheDocument();
    expect(screen.getByText(/Abort/i)).toBeInTheDocument();
    expect(screen.queryByText(/Send back/i)).not.toBeInTheDocument();
  });

  it("renders 'Send back to Implement' when loopTargetRole is set and not at cap", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 2, loopIterations: 0 })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 0, max: 2 }}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Send back to Implement/i)).toBeInTheDocument();
  });

  it("calls onSendBack with feedback when Send back is clicked and submitted", () => {
    const onSendBack = vi.fn();
    render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 2, loopIterations: 0 })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 0, max: 2 }}
        onSendBack={onSendBack}
      />,
    );

    // Click "Send back to Implement" to open the feedback panel
    fireEvent.click(screen.getByText(/Send back to Implement/i));

    // Type feedback
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Please fix the lint errors" } });

    // Submit via the "Send back" button in the panel
    fireEvent.click(screen.getByText(/Send back ⟶/i));

    expect(onSendBack).toHaveBeenCalledWith("Please fix the lint errors");
  });

  it("does NOT render Send back when loopTargetRole is null", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Send back/i)).not.toBeInTheDocument();
  });

  it("hides Send back and shows 'Loop exhausted' at cap", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 2, loopIterations: 2 })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 2, max: 2 }}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Send back to/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Loop exhausted/i)).toBeInTheDocument();
  });

  it("shows iteration meta when loopState is set and not at cap", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 2, loopIterations: 1 })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 1, max: 2 }}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Review loop · 1 of 2 used/i)).toBeInTheDocument();
  });
});

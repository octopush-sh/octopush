import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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
    diffSnapshot: null,
    maxIterations: 25,
    parents: [],
    tools: null,
    customName: null,
    instructions: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CheckpointBar", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("renders Approve, Reject, Abort for a normal checkpoint (no loop)", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
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
        onResume={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 0, max: 2 }}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Send back to Implement/i)).toBeInTheDocument();
  });

  it("calls onSendBack with feedback when Send back is clicked and submitted", () => {
    vi.useFakeTimers(); // the decision row crossfades into the feedback editor
    const onSendBack = vi.fn();
    render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 2, loopIterations: 0 })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 0, max: 2 }}
        onSendBack={onSendBack}
      />,
    );

    // Click "Send back to Implement" to open the feedback panel
    fireEvent.click(screen.getByText(/Send back to Implement/i));
    act(() => { vi.advanceTimersByTime(130); }); // let the FadeSwap settle

    // Type feedback
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Please fix the lint errors" } });

    // Submit via the "Send back" button in the panel
    fireEvent.click(screen.getByText(/^Send back$/));

    expect(onSendBack).toHaveBeenCalledWith("Please fix the lint errors");
  });

  it("does NOT render Send back when loopTargetRole is null", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
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
        onResume={vi.fn()}
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
        onResume={vi.fn()}
        loopTargetRole="Implement"
        loopState={{ iteration: 1, max: 2 }}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/review loop/i)).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("renders loop numerals tabular and turns the meter brass at cap (S2)", () => {
    const props = {
      onApprove: vi.fn(), onReject: vi.fn(), onAbort: vi.fn(), onResume: vi.fn(),
      loopTargetRole: "Implement", onSendBack: vi.fn(),
    };
    const { rerender } = render(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 3, loopIterations: 1 })}
        loopState={{ iteration: 1, max: 3 }}
        {...props}
      />,
    );
    const numerals = screen.getByText("1 of 3");
    expect(numerals.className).toContain("octo-tabular");
    expect(screen.getByText(/review loop/i).className).toContain("text-octo-mute");

    rerender(
      <CheckpointBar
        blockedStage={makeStage({ loopMode: "gated", loopTargetPosition: 0, loopMaxIterations: 3, loopIterations: 3 })}
        loopState={{ iteration: 3, max: 3 }}
        {...props}
      />,
    );
    expect(screen.getByText("3/3").className).toContain("octo-tabular");
    expect(screen.getByText(/loop exhausted/i).className).toContain("text-octo-brass");
  });

  it("shows the failed stage's actual error (first line) in the decision strip (F2)", () => {
    const error =
      "agentic loop hit 25 iterations without finishing — review the work journal, then re-run or abort\nsecond line detail";
    render(
      <CheckpointBar
        blockedStage={makeStage({ status: "failed", role: "implement", error })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    // The strip carries the error's first line, not the generic copy.
    expect(screen.getByText(/agentic loop hit 25 iterations/)).toBeInTheDocument();
    expect(screen.queryByText(/Re-run it or abort the run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/second line detail/)).not.toBeInTheDocument(); // first line only
    // The full text stays reachable via the hover title.
    expect(screen.getByTitle(/second line detail/)).toBeInTheDocument();
  });

  it("failed mode offers Accept & continue (brass-outlined) wired to onApprove (F3)", () => {
    const onApprove = vi.fn();
    render(
      <CheckpointBar
        blockedStage={makeStage({ status: "failed", role: "implement", error: "halted" })}
        onApprove={onApprove}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    const accept = screen.getByRole("button", { name: /Accept & continue/ });
    // Outlined, not the solid brass CTA (the bar keeps at most one solid brass).
    expect(accept.className).toContain("border-octo-brass");
    expect(accept.className).not.toContain("bg-octo-brass");
    fireEvent.click(accept);
    expect(onApprove).toHaveBeenCalledTimes(1);
    // Re-run and Abort remain.
    expect(screen.getByText(/^Re-run$/)).toBeInTheDocument();
    expect(screen.getByText(/^Abort$/)).toBeInTheDocument();
  });

  it("transient halt offers Resume (amber) instead of Accept, wired to onResume", () => {
    const onResume = vi.fn();
    const error =
      "Anthropic API error 429 Too Many Requests: rate_limit_error — 450,000 input tokens per minute";
    render(
      <CheckpointBar
        blockedStage={makeStage({ status: "failed", role: "implement", error })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={onResume}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    // A transient fault reads as a recoverable caution, not a hard failure.
    expect(screen.getByText(/awaiting retry/i)).toBeInTheDocument();
    const resume = screen.getByRole("button", { name: /Resume the stage/ });
    // Amber, never brass — and never the solid CTA.
    expect(resume.className).toContain("border-octo-warning");
    expect(resume.className).not.toContain("bg-octo-brass");
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
    // Accept & continue is withheld — accepting half-done infra-halted work is a footgun.
    expect(screen.queryByText(/Accept & continue/)).not.toBeInTheDocument();
    // Re-run (feedback path) and Abort remain available.
    expect(screen.getByText(/^Re-run$/)).toBeInTheDocument();
    expect(screen.getByText(/^Abort$/)).toBeInTheDocument();
  });

  it("a non-transient (fatal) halt keeps Accept & continue, not Resume", () => {
    render(
      <CheckpointBar
        blockedStage={makeStage({ status: "failed", role: "implement", error: "agentic loop hit 25 iterations without finishing" })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbort={vi.fn()}
        onResume={vi.fn()}
        loopTargetRole={null}
        loopState={null}
        onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Accept & continue/)).toBeInTheDocument();
    expect(screen.queryByText(/Resume the stage/)).not.toBeInTheDocument();
  });

  it("resets the feedback editor when a new checkpoint arrives (bar stays mounted in the Reveal dock)", () => {
    vi.useFakeTimers();
    const props = {
      onApprove: vi.fn(), onReject: vi.fn(), onAbort: vi.fn(), onResume: vi.fn(),
      loopTargetRole: null, loopState: null, onSendBack: vi.fn(),
    };
    const { rerender } = render(<CheckpointBar blockedStage={makeStage()} {...props} />);

    // Open the reject editor and type feedback, but don't submit.
    fireEvent.click(screen.getByText(/^Reject$/));
    act(() => { vi.advanceTimersByTime(130); });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "stale text" } });

    // A different stage pauses next — the editor must reset to the decision row.
    rerender(<CheckpointBar blockedStage={makeStage({ id: "s2", role: "test" })} {...props} />);
    act(() => { vi.advanceTimersByTime(130); });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Approve/i)).toBeInTheDocument();

    // And reopening the editor starts blank.
    fireEvent.click(screen.getByText(/^Reject$/));
    act(() => { vi.advanceTimersByTime(130); });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RunStage, RunStageStatus } from "../lib/ipc";

// ─── Mocks (wired before the component is imported) ───────────────────────────
// The live journal is irrelevant to these structural assertions — always empty.
vi.mock("../stores/runsStore", () => ({
  useRunsStore: (selector: (s: { liveByStage: Record<string, unknown> }) => unknown) =>
    selector({ liveByStage: {} }),
}));
// Freeze elapsed so the "running" slot is deterministic.
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => "" }));

const { RunFlow } = await import("./RunFlow");

// ─── Fixture ──────────────────────────────────────────────────────────────────

function makeStage(overrides: Partial<RunStage> = {}): RunStage {
  return {
    id: "s1",
    runId: "r1",
    position: 0,
    role: "implement",
    agentModel: "claude-sonnet-4-6",
    substrate: "api",
    checkpoint: false,
    status: "pending" as RunStageStatus,
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
    loopMode: null,
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

describe("RunFlow", () => {
  it("renders a card per stage with its title and Roman numeral", () => {
    const stages = [
      makeStage({ id: "a", position: 0, role: "plan" }),
      makeStage({ id: "b", position: 1, role: "implement" }),
    ];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.getByText("I")).toBeInTheDocument();
    expect(screen.getByText("II")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("shows the running treatment: status word and the elapsed slot", () => {
    const stages = [
      makeStage({ id: "a", status: "running", startedAt: "2026-06-13T00:00:00Z" }),
    ];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    expect(screen.getByText("running")).toBeInTheDocument();
    // The running card carries the calm pulse treatment.
    expect(document.querySelector(".octo-stage-pulse")).not.toBeNull();
  });

  it("shows cost and tokens for a done stage", () => {
    const stages = [
      makeStage({
        id: "a",
        status: "done",
        costUsd: 0.5,
        inputTokens: 1200,
        outputTokens: 340,
      }),
    ];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    expect(screen.getByText("$0.50")).toBeInTheDocument();
    expect(screen.getByText("↑1200 ↓340")).toBeInTheDocument();
  });

  it("renders the loop badge for a stage with a loop target", () => {
    const stages = [
      makeStage({ id: "a", position: 0, role: "implement" }),
      makeStage({
        id: "b",
        position: 1,
        role: "code_review",
        status: "awaiting_checkpoint",
        loopTargetPosition: 0,
        loopMaxIterations: 3,
        loopIterations: 1,
      }),
    ];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    expect(screen.getByText("⟲ 1/3")).toBeInTheDocument();
  });

  it("calls onSelectStage with the stage id when a card is clicked", () => {
    const onSelect = vi.fn();
    const stages = [makeStage({ id: "pick-me" })];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={onSelect} />);

    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("pick-me");
  });

  it("shows ⟳/stalled (not ✕) for a transient-halt failure", () => {
    const stages = [
      makeStage({
        id: "a",
        status: "failed",
        error: "API error 529 overloaded",
      }),
    ];
    render(<RunFlow stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    expect(screen.getByText("stalled")).toBeInTheDocument();
    expect(screen.getByText("⟳")).toBeInTheDocument();
    expect(screen.queryByText("✕")).toBeNull();
  });
});

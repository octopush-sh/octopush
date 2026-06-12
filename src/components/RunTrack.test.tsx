import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { RunTrack } = await import("./RunTrack");
const { useRunsStore } = await import("../stores/runsStore");

function stage(over: Record<string, unknown>) {
  return {
    id: "st1", runId: "r1", position: 0, role: "code_review", agentModel: "haiku",
    substrate: "api", checkpoint: false, status: "pending", inputTokens: 0, outputTokens: 0,
    costUsd: 0, artifact: null, feedback: null, error: null,
    startedAt: null, finishedAt: null,
    loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
    ...over,
  } as any;
}
const run = { id: "r1", workspaceId: "w1", pipelineId: "p1", task: "t", status: "running",
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, budgetUsd: null } as any;

describe("RunTrack liveness", () => {
  beforeEach(() => { useRunsStore.setState({ liveByStage: {} }); vi.useRealTimers(); });

  it("shows a timer + current activity on the running stage", () => {
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "text", text: "looking" }, { kind: "tool", tool: "Read", hint: "src/auth.rs" },
    ] } });
    const running = stage({ status: "running", startedAt: "2026-06-09T00:00:00Z" });
    render(<RunTrack run={run} stages={[running]} selectedStageId={null} onSelectStage={() => {}} />);
    expect(screen.getByText(/§ Read src\/auth\.rs/)).toBeInTheDocument(); // current activity
    expect(screen.getByText(/\d\d:\d\d/)).toBeInTheDocument();            // timer
  });

  it("shows the verdict notice on a finished review", () => {
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "tool", tool: "Read", hint: "x" }, { kind: "notice", text: "Verdict: changes requested" },
    ] } });
    const done = stage({ status: "done", startedAt: "2026-06-09T00:00:00Z", finishedAt: "t" });
    render(<RunTrack run={run} stages={[done]} selectedStageId={null} onSelectStage={() => {}} />);
    expect(screen.getByText(/changes requested/)).toBeInTheDocument();
  });

  it("activity skips notice entries — shows last tool not verdict notice", () => {
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "tool", tool: "Read", hint: "x" },
      { kind: "notice", text: "Verdict: changes requested" },
    ] } });
    const running = stage({ status: "running", startedAt: "2026-06-09T00:00:00Z" });
    render(<RunTrack run={run} stages={[running]} selectedStageId={null} onSelectStage={() => {}} />);
    expect(screen.getByText(/§ Read x/)).toBeInTheDocument();
    expect(screen.queryByText(/Verdict:/)).not.toBeInTheDocument();
  });

  it("a pending stage shows no timer/activity", () => {
    render(<RunTrack run={run} stages={[stage({})]} selectedStageId={null} onSelectStage={() => {}} />);
    expect(screen.queryByText(/§ /)).not.toBeInTheDocument();
  });

  it("reserves the elapsed slot in every status (S1)", () => {
    render(<RunTrack run={run} stages={[stage({})]} selectedStageId={null} onSelectStage={() => {}} />);
    const card = screen.getByRole("button");
    const slot = card.querySelector("span.octo-tabular");
    expect(slot).not.toBeNull();
    expect(slot!.className).toContain("w-[5ch]");
    expect(slot!.textContent).toBe(""); // empty, but the slot exists
  });

  it("renders cost in the live line for idle stages and activity for running ones", () => {
    const { unmount } = render(
      <RunTrack run={run} stages={[stage({ costUsd: 0.05 })]} selectedStageId={null} onSelectStage={() => {}} />,
    );
    const cost = screen.getByText("$0.05");
    expect(cost.className).toContain("octo-tabular");
    unmount();

    useRunsStore.setState({ liveByStage: { st1: [{ kind: "tool", tool: "Bash", hint: "npm test" }] } });
    render(
      <RunTrack
        run={run}
        stages={[stage({ status: "running", startedAt: "2026-06-09T00:00:00Z" })]}
        selectedStageId={null}
        onSelectStage={() => {}}
      />,
    );
    expect(screen.getByText(/§ Bash npm test/)).toBeInTheDocument();
  });

  it("dims connectors after pending stages and brightens them after done stages", () => {
    const second = stage({ id: "st2", position: 1, role: "implement" });
    const { unmount } = render(
      <RunTrack run={run} stages={[stage({}), second]} selectedStageId={null} onSelectStage={() => {}} />,
    );
    expect(screen.getByText("⟶").className).toContain("opacity-40");
    unmount();

    render(
      <RunTrack
        run={run}
        stages={[stage({ status: "done", finishedAt: "t" }), second]}
        selectedStageId={null}
        onSelectStage={() => {}}
      />,
    );
    expect(screen.getByText("⟶").className).toContain("opacity-100");
  });
});

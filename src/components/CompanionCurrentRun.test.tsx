import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ state: {} as any }));
vi.mock("../stores/runsStore", () => ({
  useRunsStore: (sel: any) => sel(h.state),
}));

vi.mock("./ClaudePlanLine", () => ({ ClaudePlanLine: () => <div data-testid="plan-line" /> }));

const { CompanionCurrentRun } = await import("./CompanionCurrentRun");

const run = { id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "running", costUsd: 0.42, baselineUsd: 1, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, budgetUsd: null, detached: false };
const stage = (over: any) => ({
  id: over.id, runId: "r1", position: over.position ?? 0, role: over.role ?? "implement", agentModel: "m", substrate: "api",
  checkpoint: false, status: over.status ?? "pending", inputTokens: over.inputTokens ?? 0, outputTokens: over.outputTokens ?? 0,
  costUsd: 0, artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, diffSnapshot: null, maxIterations: 25,
  parents: [], tools: null, customName: over.customName ?? null, instructions: null,
});

function setState(detail: any) {
  h.state = {
    getViewedRunId: () => (detail ? "r1" : null),
    getDetail: () => detail,
    liveByStage: {},
  };
}

describe("CompanionCurrentRun", () => {
  it("renders nothing when there is no viewed run", () => {
    setState(undefined);
    const { container } = render(<CompanionCurrentRun workspaceId="w1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("spotlights the active stage with run cost and tokens", () => {
    setState({
      run,
      stages: [
        stage({ id: "s0", position: 0, role: "plan", status: "done", inputTokens: 1000, outputTokens: 200 }),
        stage({ id: "s1", position: 1, role: "implement", status: "running", customName: "Build it" }),
      ],
    });
    render(<CompanionCurrentRun workspaceId="w1" />);
    expect(screen.getByText("current run")).toBeInTheDocument();
    expect(screen.getByText("Build it")).toBeInTheDocument(); // the running stage spotlighted
    expect(screen.getByText("$0.42")).toBeInTheDocument(); // run cost
    expect(screen.getByText(/↑1\.0k ↓200/)).toBeInTheDocument(); // run tokens (shared fmtTokens)
  });

  it("shows the Claude plan line only for a run with Claude Code stages", () => {
    setState({ run, stages: [stage({ id: "s1", position: 0, status: "running" })] });
    const { unmount } = render(<CompanionCurrentRun workspaceId="w1" />);
    expect(screen.queryByTestId("plan-line")).toBeNull();
    unmount();
    setState({ run, stages: [{ ...stage({ id: "s1", position: 0, status: "running" }), substrate: "cli", agentModel: "claude-sonnet-4-5" }] });
    render(<CompanionCurrentRun workspaceId="w1" />);
    expect(screen.getByTestId("plan-line")).toBeInTheDocument();
  });

  it("draws the running status tag in verdigris, not brass", () => {
    setState({ run, stages: [stage({ id: "s1", position: 0, status: "running" })] });
    render(<CompanionCurrentRun workspaceId="w1" />);
    const tag = screen.getByTitle("running");
    expect(tag.className).toContain("text-octo-verdigris");
    expect(tag.className).not.toContain("text-octo-brass");
  });
});

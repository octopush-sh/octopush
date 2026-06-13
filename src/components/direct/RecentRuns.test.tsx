import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Run, RunStatus } from "../../lib/ipc";

const mkRun = (id: string, status: RunStatus, over: Partial<Run> = {}): Run => ({
  id,
  workspaceId: "w1",
  pipelineId: "p1",
  task: `task ${id}`,
  status,
  costUsd: 0.1,
  baselineUsd: 0,
  referenceModel: null,
  linkedIssueKey: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  budgetUsd: null,
  ...over,
});

// Selector-driven store mocks. Each store is a function called with a selector;
// we hand it a fixed state slice and let the selector pick what it needs.
const loadRuns = vi.fn();
const selectRun = vi.fn();
let runsState: Record<string, unknown>;
let pipelineState: Record<string, unknown>;

vi.mock("../../stores/runsStore", () => ({
  useRunsStore: (selector: (s: unknown) => unknown) => selector(runsState),
}));
vi.mock("../../stores/pipelineStore", () => ({
  usePipelineStore: (selector: (s: unknown) => unknown) => selector(pipelineState),
}));

const { RecentRuns } = await import("./RecentRuns");

const baseRunsState = (runs: Run[], loaded = true, viewedId: string | null = null) => ({
  loadRuns,
  selectRun,
  getRuns: (_ws: string) => runs,
  loadedByWs: { w1: loaded },
  getViewedRunId: (_ws: string) => viewedId,
});

const basePipelineState = (
  pipelines: { pipeline: { id: string; name: string } }[] = [{ pipeline: { id: "p1", name: "Bugfix" } }],
) => ({ pipelines });

describe("RecentRuns", () => {
  beforeEach(() => {
    loadRuns.mockClear();
    selectRun.mockClear();
    runsState = baseRunsState([]);
    pipelineState = basePipelineState();
  });

  it("loads runs on mount", () => {
    render(<RecentRuns workspaceId="w1" />);
    expect(loadRuns).toHaveBeenCalledWith("w1");
  });

  it("shows the empty state once loaded with no runs", () => {
    runsState = baseRunsState([], true);
    render(<RecentRuns workspaceId="w1" />);
    expect(screen.getByText("No runs yet — direct your first.")).toBeInTheDocument();
  });

  it("does not flash the empty state before the first load resolves", () => {
    runsState = baseRunsState([], false);
    render(<RecentRuns workspaceId="w1" />);
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
  });

  it("renders 8 cards and a '+N earlier' note when there are more than 8 runs", () => {
    const runs = Array.from({ length: 11 }, (_, i) => mkRun(`r${i}`, "completed"));
    runsState = baseRunsState(runs);
    render(<RecentRuns workspaceId="w1" />);
    // 8 cards shown, r0..r7
    expect(screen.getByText("task r0")).toBeInTheDocument();
    expect(screen.getByText("task r7")).toBeInTheDocument();
    expect(screen.queryByText("task r8")).not.toBeInTheDocument();
    expect(screen.getByText("+3 earlier in the Runs rail")).toBeInTheDocument();
  });

  it("clicking a card calls selectRun with the run id", () => {
    const runs = [mkRun("ra", "completed"), mkRun("rb", "running")];
    runsState = baseRunsState(runs);
    render(<RecentRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText("task rb"));
    expect(selectRun).toHaveBeenCalledWith("w1", "rb");
  });
});

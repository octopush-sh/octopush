import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RunStatus } from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/ipc", async (orig) => {
  const actual = await orig<any>();
  return { ...actual, ipc: { ...actual.ipc, listRuns: vi.fn().mockResolvedValue([]) } };
});

const { CompanionRuns } = await import("./CompanionRuns");
const { useRunsStore } = await import("../stores/runsStore");

const mkRun = (id: string, status: RunStatus, over: Record<string, unknown> = {}) => ({
  id, workspaceId: "w1", pipelineId: "p", task: `task ${id}`,
  status, costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, ...over });

describe("CompanionRuns hub", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: { w1: [mkRun("rRun", "running"), mkRun("rDone", "completed")] },
      activeRunIdByWs: { w1: "rRun" }, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
  });

  it("clicking a run row selects it for viewing", () => {
    render(<CompanionRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText("task rDone"));
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rDone");
  });

  it("'Begin a new run' selects the launcher (null)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText(/Begin a new run/i));
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe(null);
  });

  it("shows the cumulative savings ledger when baselines exist", () => {
    useRunsStore.setState({
      runsByWs: { w1: [
        mkRun("a", "completed", { baselineUsd: 0.5, costUsd: 0.1 }),
        mkRun("b", "completed", { baselineUsd: 0.3, costUsd: 0.1 }),
      ] },
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.getAllByText(/across 2 runs/).length).toBeGreaterThan(0);
    const saved = screen.getByText("$0.60"); // (0.5-0.1) + (0.3-0.1), tabular
    expect(saved.className).toContain("octo-tabular");
  });

  it("hides the ledger when no run has a baseline", () => {
    render(<CompanionRuns workspaceId="w1" />); // default rows have baselineUsd 0
    expect(screen.queryByText(/across/)).not.toBeInTheDocument();
  });

  it("reserves the executing-dot slot on every row (S1)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    const doneRow = screen.getByText("task rDone").closest("button")!;
    const dot = doneRow.querySelector("span.text-transparent");
    expect(dot).not.toBeNull(); // slot reserved even when not executing
    expect(dot!.className).toContain("w-2");
    expect(dot!.textContent).toBe("●");
    const runRow = screen.getByText("task rRun").closest("button")!;
    expect(runRow.querySelector("span.text-transparent")).toBeNull();
    expect(runRow.querySelector("span.text-octo-brass")?.textContent).toBe("●");
  });

  it("uses the new empty-state copy", () => {
    useRunsStore.setState({
      runsByWs: { w1: [] },
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.getByText("No runs yet — direct your first.")).toBeInTheDocument();
  });
});

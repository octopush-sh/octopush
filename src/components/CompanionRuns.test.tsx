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
      loadedByWs: { w1: true },
      activeRunIdByWs: { w1: "rRun" }, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
  });

  it("clicking a run row selects it for viewing", () => {
    render(<CompanionRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText("task rDone"));
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rDone");
  });

  it("renders a standard eyebrow bar with a plain Runs label (no count)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    const eyebrow = screen.getByText("Runs");
    expect(eyebrow.className).toContain("tracking-[0.3em]");
    expect(eyebrow.className).toContain("text-octo-brass");
    expect(screen.queryByText(/· 2/)).not.toBeInTheDocument();
  });

  it("the new-run icon button selects the launcher (null)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    const btn = screen.getByRole("button", { name: "Begin a new run" });
    expect(btn).toHaveAttribute("title", "Begin a new run");
    fireEvent.click(btn);
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

  it("counts only runs that actually saved in the ledger n", () => {
    useRunsStore.setState({
      runsByWs: { w1: [
        mkRun("a", "completed", { baselineUsd: 0.5, costUsd: 0.1 }),  // saved 0.40
        mkRun("b", "completed", { baselineUsd: 0.2, costUsd: 0.35 }), // over baseline — saved nothing
      ] },
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.getByText(/across 1 run\b/)).toBeInTheDocument();
    expect(screen.getByText("$0.40")).toBeInTheDocument();
  });

  it("hides the ledger when no run has a baseline", () => {
    render(<CompanionRuns workspaceId="w1" />); // default rows have baselineUsd 0
    expect(screen.queryByText(/across/)).not.toBeInTheDocument();
  });

  it("hides the ledger when total savings round to $0.00", () => {
    useRunsStore.setState({
      runsByWs: { w1: [mkRun("a", "completed", { baselineUsd: 0.102, costUsd: 0.1 })] }, // saved 0.002
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.queryByText(/across/)).not.toBeInTheDocument();
  });

  it("renders exactly one status glyph per row, in the fixed slot (S1)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    const doneRow = screen.getByText("task rDone").closest("button")!;
    const doneSlot = doneRow.querySelector("span.w-2")!;
    expect(doneSlot.textContent).toBe("✓");
    expect(doneSlot.className).toContain("text-octo-verdigris");
    expect(doneRow.textContent).not.toContain("✓ done ✓"); // word carries no glyph
    expect(doneRow.textContent).toContain("done");

    const runRow = screen.getByText("task rRun").closest("button")!;
    const runSlot = runRow.querySelector("span.w-2")!;
    expect(runSlot.textContent).toBe("●");
    expect(runSlot.className).toContain("text-octo-brass");
    // The glyph appears once: in the slot, not duplicated beside the word.
    expect((runRow.textContent!.match(/●/g) ?? []).length).toBe(1);
    expect(runRow.textContent).toContain("running");
  });

  it("gives truncated task text a full-task tooltip", () => {
    render(<CompanionRuns workspaceId="w1" />);
    const row = screen.getByText("task rDone").closest("button")!;
    expect(row).toHaveAttribute("title", "task rDone");
  });

  it("uses the new empty-state copy once loading has resolved", () => {
    useRunsStore.setState({
      runsByWs: { w1: [] }, loadedByWs: { w1: true },
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.getByText("No runs yet — direct your first.")).toBeInTheDocument();
  });

  it("does not flash the empty state before the first load resolves", () => {
    useRunsStore.setState({
      runsByWs: {}, loadedByWs: {},
      activeRunIdByWs: {}, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
    render(<CompanionRuns workspaceId="w1" />);
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the heavy children — the dashboard's job is composition (header +
// overview + hosting the composer and the runs rail), which is what we assert.
vi.mock("../PipelineSetup", () => ({ PipelineSetup: () => <div data-testid="composer">COMPOSER</div> }));
vi.mock("./RecentRuns", () => ({ RecentRuns: ({ workspaceId }: { workspaceId: string }) => <div>RUNS:{workspaceId}</div> }));

// runsStore drives DirectOverview (rendered for real). vi.hoisted so the mock
// factory can read the mutable run list.
const h = vi.hoisted(() => ({ runs: [] as Array<Record<string, unknown>> }));
vi.mock("../../stores/runsStore", () => ({
  useRunsStore: (sel: (s: { getRuns: () => unknown[] }) => unknown) => sel({ getRuns: () => h.runs }),
}));

const { DirectDashboard } = await import("./DirectDashboard");

const props = {
  workspaceId: "ws1",
  defaultTask: "",
  onBegin: vi.fn(),
  executingRun: false,
  onEditPipeline: vi.fn(),
};

describe("DirectDashboard", () => {
  it("renders the ceremony header and hosts the composer + runs rail", () => {
    h.runs = [];
    render(<DirectDashboard {...props} />);
    expect(screen.getByRole("heading", { name: "Direct the work" })).toBeInTheDocument();
    expect(screen.getByText("direct")).toBeInTheDocument(); // eyebrow (uppercased by CSS)
    expect(screen.getByTestId("composer")).toBeInTheDocument();
    expect(screen.getByText("RUNS:ws1")).toBeInTheDocument(); // workspaceId threaded through
  });

  it("hides the overview when there are no runs", () => {
    h.runs = [];
    render(<DirectDashboard {...props} />);
    expect(screen.queryByText("saved")).not.toBeInTheDocument();
  });

  it("shows the overview (saved · runs · in flight) once runs exist", () => {
    h.runs = [
      { id: "r1", status: "completed", costUsd: 1, baselineUsd: 3 },
      { id: "r2", status: "running", costUsd: 0.5, baselineUsd: 0 },
    ];
    render(<DirectDashboard {...props} />);
    expect(screen.getByText("saved")).toBeInTheDocument();
    expect(screen.getByText("$2.00")).toBeInTheDocument(); // baseline 3 − cost 1
    expect(screen.getByText("in flight")).toBeInTheDocument();
  });
});

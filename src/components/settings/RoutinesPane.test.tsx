import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ModelRetirement, PipelineWithStages, Routine } from "../../lib/ipc";

const retirementsMock = vi.hoisted(() => ({ value: [] as ModelRetirement[] }));
vi.mock("../../hooks/useModelRetirements", () => ({ useModelRetirements: () => retirementsMock.value }));

import { RoutinesPane } from "./RoutinesPane";
import { useEntitlementStore } from "../../stores/entitlementStore";
import { useRoutinesStore } from "../../stores/routinesStore";
import { useProjectStore } from "../../stores/projectStore";
import { usePipelineStore } from "../../stores/pipelineStore";

function setPlan(features: string[]) {
  useEntitlementStore.setState({
    entitlement: {
      plan: features.length ? "pro" : "free",
      features,
      directRunsPerMonth: null,
    },
    loaded: true,
  });
}

beforeEach(() => {
  // Keep the pane's mount-time loads off IPC.
  useRoutinesStore.setState({ routines: [], load: vi.fn(async () => {}) });
  useProjectStore.setState({ recent: [], loadRecent: vi.fn(async () => {}) });
  usePipelineStore.setState({ pipelines: [], load: vi.fn(async () => {}) });
  retirementsMock.value = [];
});

describe("RoutinesPane retiring models", () => {
  const crew = (id: string, agentModel: string): PipelineWithStages => ({
    pipeline: { id, name: id, description: "", isBuiltin: false, createdAt: "t" },
    stages: [{
      id: `${id}-s0`, pipelineId: id, position: 0, role: "implement", agentModel, escalateModel: null, substrate: "api",
      checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
      posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
    }],
  });
  const routine = (id: string, pipelineId: string, stageOverrides: string | null = null): Routine => ({
    id, name: id, projectId: "pr", pipelineId, task: "t", referenceModel: null, stageOverrides, budgetUsd: null,
    scheduleKind: "daily", scheduleSpec: "06:00", workspaceMode: "fresh", fixedWorkspaceId: null, baseBranch: null,
    branchPrefix: null, enabled: true, lastFiredAt: null, nextDueAt: null, lastRunId: null, createdAt: "t",
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    setPlan(["routines.scheduled"]);
    retirementsMock.value = [
      { model: "claude-sonnet-4-5", label: "Sonnet 4.5", retires: "2026-11-30", replacement: "claude-sonnet-5-5", replacementLabel: "Sonnet 5.5" },
    ];
    usePipelineStore.setState({ pipelines: [crew("old", "claude-sonnet-4-5"), crew("new", "claude-sonnet-5-5")] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns on a Routine whose crew, or its override, uses a retiring model — and only there", () => {
    useRoutinesStore.setState({
      routines: [routine("Nightly", "old"), routine("Fine", "new"), routine("Picked", "new", '[[0,"claude-sonnet-4-5"]]')],
    });
    render(<RoutinesPane />);
    const lines = screen.getAllByTestId("routine-model-retirement");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Sonnet 4.5 retires Nov 30, so this routine will fail after that.");
    expect(lines[0]).toHaveAttribute("data-tour", "routines-model-retirement");
    expect(lines[0]).toHaveClass("text-octo-warning");
    expect(lines[1]).not.toHaveAttribute("data-tour");
  });

  it("turns rouge once the model has retired", () => {
    vi.setSystemTime(new Date("2026-12-01T06:00:00Z"));
    useRoutinesStore.setState({ routines: [routine("Nightly", "old")] });
    render(<RoutinesPane />);
    const line = screen.getByTestId("routine-model-retirement");
    expect(line).toHaveTextContent("Sonnet 4.5 retired Nov 30, so this routine will fail.");
    expect(line).toHaveClass("text-octo-rouge");
  });
});

describe("RoutinesPane upgrade banner", () => {
  it("offers Pro as a ceremonial brass-ghost phrase for a free user", () => {
    setPlan([]);
    render(<RoutinesPane />);
    const cta = screen.getByRole("button", { name: "Put your crews on a schedule with Pro" });
    expect(cta.className).toContain("bg-[var(--brass-ghost)]");
    expect(cta.className).toContain("border-[var(--brass-dim)]");
    expect(cta.className).toContain("font-serif");
    expect(screen.queryByText("Upgrade to Pro")).not.toBeInTheDocument();
  });

  it("shows no upgrade banner for an entitled user", () => {
    setPlan(["routines.scheduled"]);
    render(<RoutinesPane />);
    expect(
      screen.queryByRole("button", { name: "Put your crews on a schedule with Pro" }),
    ).not.toBeInTheDocument();
  });
});

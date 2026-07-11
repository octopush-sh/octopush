import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../stores/runsStore", () => ({
  useRunsStore: (sel: any) => sel({ liveByStage: {} }),
}));
vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ roles: [] }) },
}));
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => "00:00" }));
vi.mock("./RunFlowNav", () => ({ RunFlowNav: () => null }));

const { RunFlow } = await import("./RunFlow");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const mk = (over: Record<string, unknown>) =>
  ({
    id: "x", runId: "r", position: 0, role: "implement", agentModel: "sonnet",
    substrate: "api", checkpoint: false, status: "pending", inputTokens: 0,
    outputTokens: 0, costUsd: 0, artifact: null, feedback: null, error: null,
    startedAt: null, finishedAt: null, loopTargetPosition: null,
    loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
    diffSnapshot: null, ...over,
  }) as any;

const stages = [
  mk({ id: "a", position: 0, status: "done", costUsd: 0.01 }),
  mk({ id: "b", position: 1, status: "running", startedAt: 1 }),
  mk({ id: "c", position: 2, status: "pending", checkpoint: true }),
];

describe("RunFlow — depth of field & the single beacon", () => {
  it("pulses exactly one element: the beacon stage", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(1);
  });

  it("never pulses without a beacon, even while running", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0);
  });

  it("recedes non-subject cards to a dimmed essence", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    // done + pending recede; the running subject keeps full ink
    expect(container.querySelectorAll(".opacity-\\[0\\.38\\]")).toHaveLength(2);
  });

  it("draws connectors as lines — no arrows, no romans", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId={null} beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.textContent).not.toContain("⟶");
    expect(container.textContent).not.toMatch(/\b(II|III|IV|V|VI)\b/);
    // the gate mark lives on the gated card, not the connector
    expect(container.textContent).toContain("⟜");
  });
});

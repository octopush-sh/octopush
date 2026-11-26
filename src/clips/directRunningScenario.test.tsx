// The `direct-running` clip scenario (#981): the context-meter changeset's
// first step points at the running card's reading, so the scenario must give
// Direct a running Claude Code stage whose reading the card does not shed.
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { createDispatcher } from "./dispatcher";
import { SCENARIOS } from "../../scripts/clips/scenarios";
import { DEFAULT_FIXTURES } from "../../scripts/clips/scenarios/default";
import type { Run, RunDetail } from "../lib/ipc";
import { stageContextReading, subjectShedsContext } from "../lib/stageMeta";
import { shortModel } from "../lib/modelLabel";

const live = vi.hoisted(() => ({ liveByStage: {}, liveContextByStage: {} }));
vi.mock("../stores/runsStore", () => ({ useRunsStore: (sel: (s: typeof live) => unknown) => sel(live) }));
vi.mock("../stores/rolesStore", () => ({ useRolesStore: { getState: () => ({ roles: [] }) } }));
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => "00:00" }));
vi.mock("../components/RunFlowNav", () => ({
  RunFlowNav: () => null,
  useRailEdges: () => ({ overflowing: false, atStart: true, atEnd: true }),
  railEdgeFade: () => "",
}));

const { RunFlow } = await import("../components/RunFlow");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const ACTIVE = DEFAULT_FIXTURES.WORKSPACES[1];
const TERMINAL = new Set(["completed", "failed", "aborted"]);

function liveRun() {
  const { handle } = createDispatcher(SCENARIOS["direct-running"]);
  const runs = handle("list_runs", { workspaceId: ACTIVE.id }) as Run[];
  // What Direct opens on: the freshest non-terminal run (runsStore.loadRuns).
  const run = runs.find((r) => !TERMINAL.has(r.status))!;
  const detail = handle("get_run", { runId: run.id }) as RunDetail;
  return { handle, runs, run, detail };
}

describe("direct-running scenario", () => {
  it("is registered and keeps the default scenario's finished run", () => {
    expect(SCENARIOS["direct-running"].name).toBe("direct-running");
    const { runs, run, handle } = liveRun();
    expect(run.status).toBe("running");
    expect(runs.map((r) => r.id)).toContain(DEFAULT_FIXTURES.RUN.id);
    expect((handle("list_active_runs") as Run[]).map((r) => r.id)).toEqual([run.id]);
  });

  it("runs its current stage on Claude Code with a 142k / 200k reading the card keeps", () => {
    const { detail } = liveRun();
    const running = detail.stages.filter((s) => s.status === "running");
    expect(running).toHaveLength(1);
    const [stage] = running;
    expect(stage.substrate).toBe("cli");
    expect(stage.agentModel.startsWith("claude-")).toBe(true);
    expect([stage.contextTokens, stage.contextWindow]).toEqual([142_000, 200_000]);
    expect(stage.effort ?? null).toBeNull();
    expect(stage.escalateModel ?? null).toBeNull();
    expect(stage.escalated).toBe(false);
    expect(stage.ranModel ?? null).toBeNull();

    const reading = stageContextReading(stage)!;
    expect(reading.cardLabel).toBe("ctx 71%");
    expect(reading.label).toBe("ctx 142k / 200k");
    // No notes beside it, so the card's meta line has room for the reading.
    expect(subjectShedsContext(String(stage.position + 1), shortModel(stage.agentModel), reading.cardLabel, [])).toBe(false);
  });

  it("renders the reading on the running card, not shed (the changeset's first step)", () => {
    const { detail } = liveRun();
    const current = detail.stages.find((s) => s.status === "running")!;
    const { container } = render(
      <RunFlow stages={detail.stages} selectedStageId={current.id} beaconStageId={null} onSelectStage={() => {}} />,
    );
    const meter = container.querySelectorAll('[data-tour="direct-stage-context"]');
    expect(meter).toHaveLength(1);
    expect(meter[0]).toHaveTextContent("ctx 71%");
    expect(meter[0]).not.toHaveClass("octo-demote-shed");
  });

  it("orders its stages done, running, then pending", () => {
    const { detail } = liveRun();
    expect(detail.stages.map((s) => s.status)).toEqual(["done", "running", "pending", "pending"]);
    expect(detail.stages.every((s) => s.runId === detail.run!.id)).toBe(true);
  });
});

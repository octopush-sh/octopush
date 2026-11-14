import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRetirement, PipelineStage, PipelineWithStages, Routine } from "./ipc";

const ipcMock = vi.hoisted(() => ({ modelRetirements: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: ipcMock }));

const {
  crewModels, crewRetirements, daysUntilRetirement, libraryModels, loadModelRetirements, readinessRetirementCheck,
  resetModelRetirementCache, retirementDay, retirementLine, retirementPhase, routineOverrides, routineRetirement,
} = await import("./modelRetirement");

const sonnet45 = (model = "claude-sonnet-4-5"): ModelRetirement => ({
  model, label: "Sonnet 4.5", retires: "2026-11-30", replacement: "claude-sonnet-5-5", replacementLabel: "Sonnet 5.5",
});

const at = (iso: string) => new Date(iso);

function stage(position: number, agentModel: string, escalateModel: string | null = null): PipelineStage {
  return {
    id: `s${position}`, pipelineId: "p", position, role: "implement", agentModel, escalateModel,
    substrate: "api", checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null,
    maxIterations: 25, posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
  };
}

function crew(id: string, name: string, stages: PipelineStage[]): PipelineWithStages {
  return { pipeline: { id, name, description: "", isBuiltin: false, createdAt: "t" }, stages };
}

function routine(name: string, pipelineId: string, stageOverrides: string | null = null): Routine {
  return {
    id: name, name, projectId: "pr", pipelineId, task: "t", referenceModel: null, stageOverrides, budgetUsd: null,
    scheduleKind: "daily", scheduleSpec: "06:00", workspaceMode: "fresh", fixedWorkspaceId: null, baseBranch: null,
    branchPrefix: null, enabled: true, lastFiredAt: null, nextDueAt: null, lastRunId: null, createdAt: "t",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelRetirementCache();
});

describe("retirement date math", () => {
  it("counts whole UTC days to the retirement day", () => {
    expect(daysUntilRetirement("2026-11-30", at("2026-11-14T12:00:00Z"))).toBe(16);
    expect(daysUntilRetirement("2026-11-30", at("2026-11-30T23:59:00Z"))).toBe(0);
    expect(daysUntilRetirement("2026-11-30", at("2026-12-01T00:00:00Z"))).toBe(-1);
    expect(daysUntilRetirement("soon", at("2026-11-14T12:00:00Z"))).toBeNull();
  });

  it("is quiet before the 30-day window", () => {
    expect(retirementPhase("2026-11-30", at("2026-10-30T12:00:00Z"))).toBeNull();
    expect(retirementPhase("2026-11-30", at("2026-08-01T12:00:00Z"))).toBeNull();
  });

  it("is soon inside the window, the retirement day included", () => {
    expect(retirementPhase("2026-11-30", at("2026-10-31T00:00:00Z"))).toEqual({ kind: "soon", daysLeft: 30 });
    expect(retirementPhase("2026-11-30", at("2026-11-14T08:00:00Z"))).toEqual({ kind: "soon", daysLeft: 16 });
    expect(retirementPhase("2026-11-30", at("2026-11-30T20:00:00Z"))).toEqual({ kind: "soon", daysLeft: 0 });
  });

  it("is retired after the day, and stays so", () => {
    expect(retirementPhase("2026-11-30", at("2026-12-01T00:00:00Z"))).toEqual({ kind: "retired" });
    expect(retirementPhase("2026-11-30", at("2027-06-01T00:00:00Z"))).toEqual({ kind: "retired" });
  });

  it("names the day, with the year only when it isn't this year", () => {
    expect(retirementDay("2026-11-30", at("2026-11-14T00:00:00Z"))).toBe("Nov 30");
    expect(retirementDay("2026-11-30", at("2027-01-04T00:00:00Z"))).toBe("Nov 30, 2026");
  });

  it("says what will fail, before and after", () => {
    const now = at("2026-11-14T00:00:00Z");
    expect(retirementLine(sonnet45(), { kind: "soon", daysLeft: 16 }, now, "a stage on it"))
      .toBe("Sonnet 4.5 retires Nov 30, so a stage on it will fail after that.");
    expect(retirementLine(sonnet45(), { kind: "retired" }, now, "this routine"))
      .toBe("Sonnet 4.5 retired Nov 30, so this routine will fail.");
  });
});

describe("crews on a retiring model", () => {
  const now = at("2026-11-14T00:00:00Z");

  it("collects stage, override and escalation models once", () => {
    const stages = [stage(0, "claude-opus-5-5", "claude-sonnet-4-5"), stage(1, "claude-sonnet-5-5")];
    expect(crewModels(stages)).toEqual(["claude-opus-5-5", "claude-sonnet-4-5", "claude-sonnet-5-5"]);
    expect(crewModels(stages, { 1: "claude-opus-5-5" })).toEqual(["claude-opus-5-5", "claude-sonnet-4-5"]);
  });

  it("folds the dated and undated ids into one notice, counting stages", () => {
    const stages = [stage(0, "claude-sonnet-4-5-20250929"), stage(1, "claude-opus-5-5", "claude-sonnet-4-5"), stage(2, "claude-sonnet-5-5")];
    const [n, ...rest] = crewRetirements(stages, [sonnet45("claude-sonnet-4-5-20250929"), sonnet45()], now);
    expect(rest).toEqual([]);
    expect(n.ids).toEqual(["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"]);
    expect(n.stages).toBe(2);
    expect(n.phase).toEqual({ kind: "soon", daysLeft: 16 });
  });

  it("says nothing before the window or for models the crew doesn't use", () => {
    expect(crewRetirements([stage(0, "claude-sonnet-4-5")], [sonnet45()], at("2026-10-01T00:00:00Z"))).toEqual([]);
    expect(crewRetirements([stage(0, "claude-sonnet-5-5")], [sonnet45()], now)).toEqual([]);
  });

  it("a launcher or Routine override replaces the stage's own model", () => {
    expect(crewRetirements([stage(0, "claude-sonnet-4-5")], [sonnet45()], now, { 0: "claude-sonnet-5-5" })).toEqual([]);
    expect(crewRetirements([stage(0, "claude-sonnet-5-5")], [sonnet45()], now, { 0: "claude-sonnet-4-5" })).toHaveLength(1);
  });

  it("reads Routine overrides as saved, and bad JSON as none", () => {
    expect(routineOverrides('[[0,"claude-sonnet-4-5"],[2,"claude-opus-5-5"]]')).toEqual({ 0: "claude-sonnet-4-5", 2: "claude-opus-5-5" });
    expect(routineOverrides("not json")).toEqual({});
    expect(routineOverrides(null)).toEqual({});
  });

  it("a Routine gets its crew's notice with its own overrides", () => {
    const pipelines = [crew("p", "Relay", [stage(0, "claude-sonnet-5-5")])];
    expect(routineRetirement(routine("Nightly", "p"), pipelines, [sonnet45()], now)).toBeNull();
    expect(routineRetirement(routine("Nightly", "p", '[[0,"claude-sonnet-4-5"]]'), pipelines, [sonnet45()], now)?.stages).toBe(1);
    expect(routineRetirement(routine("Gone", "missing"), pipelines, [sonnet45()], now)).toBeNull();
    expect(libraryModels(pipelines, [routine("Nightly", "p", '[[0,"claude-sonnet-4-5"]]')]))
      .toEqual(["claude-sonnet-5-5", "claude-sonnet-4-5"]);
  });
});

describe("the Readiness row", () => {
  const pipelines = [
    crew("a", "Relay", [stage(0, "claude-sonnet-4-5")]),
    crew("b", "Scout", [stage(0, "claude-sonnet-5-5")]),
  ];

  it("names the crews and Routines that will fail, amber before the day", () => {
    const row = readinessRetirementCheck(pipelines, [routine("Nightly", "b", '[[0,"claude-sonnet-4-5"]]')], [sonnet45()], at("2026-11-14T00:00:00Z"));
    expect(row).toMatchObject({ id: "models", label: "Crew models", status: "warn", value: "Sonnet 4.5 · retires Nov 30", command: null });
    expect(row?.fix).toBe(
      "Sonnet 4.5 retires Nov 30, so 1 crew and 1 Routine on it will fail after that. Relay, Routine Nightly. Switch each to Sonnet 5.5 from the Direct launcher.",
    );
  });

  it("fails after the day, and is absent when nothing uses it", () => {
    expect(readinessRetirementCheck(pipelines, [], [sonnet45()], at("2026-12-02T00:00:00Z"))?.status).toBe("fail");
    expect(readinessRetirementCheck([pipelines[1]], [], [sonnet45()], at("2026-11-14T00:00:00Z"))).toBeNull();
    expect(readinessRetirementCheck(pipelines, [], [], at("2026-11-14T00:00:00Z"))).toBeNull();
  });
});

describe("loadModelRetirements", () => {
  it("asks the backend once per id and answers from the session cache after", async () => {
    ipcMock.modelRetirements.mockResolvedValue([sonnet45()]);
    expect(await loadModelRetirements(["claude-sonnet-4-5", "claude-opus-5-5"])).toEqual([sonnet45()]);
    expect(await loadModelRetirements(["claude-opus-5-5", "claude-sonnet-4-5"])).toEqual([sonnet45()]);
    expect(ipcMock.modelRetirements).toHaveBeenCalledTimes(1);
    expect(ipcMock.modelRetirements).toHaveBeenCalledWith(["claude-sonnet-4-5", "claude-opus-5-5"]);
  });

  it("a failed read says nothing and is asked again", async () => {
    ipcMock.modelRetirements.mockRejectedValueOnce(new Error("no backend"));
    expect(await loadModelRetirements(["claude-sonnet-4-5"])).toEqual([]);
    ipcMock.modelRetirements.mockResolvedValue([sonnet45()]);
    expect(await loadModelRetirements(["claude-sonnet-4-5"])).toEqual([sonnet45()]);
  });
});

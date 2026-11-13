import { describe, expect, it } from "vitest";
import type { PipelineStage, PipelineWithStages } from "./ipc";
import type { ModelInfo, ProviderConfig } from "./types";
import {
  keepLabel, pipelineSupersessions, savingPercent, supersededLine, supersededOnCli, supersessionMap, switchedDraft,
} from "./supersededModels";

function model(id: string, displayName: string, input: number, output: number, supersededBy?: string): ModelInfo {
  return {
    id, displayName, inputCostPerM: input, outputCostPerM: output, cacheReadCostPerM: 0, cacheCreationCostPerM: 0,
    maxContext: 1_000_000, supportsVision: true, supportsTools: true, supersededBy,
  };
}

const catalog: ProviderConfig[] = [
  {
    name: "anthropic",
    models: [
      model("claude-fable-5-2", "Claude Fable 5.2", 8, 40),
      model("claude-fable-5-1", "Claude Fable 5.1", 10, 50, "claude-fable-5-2"),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10),
    ],
  } as unknown as ProviderConfig,
];

function stage(position: number, agentModel: string, extra: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: `s${position}`, pipelineId: "p", position, role: "implement", agentModel, effort: "high",
    escalateModel: null, escalateEffort: null, substrate: "api", checkpoint: position === 0,
    loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
    posX: position * 10, posY: 5, parents: position > 0 ? [position - 1] : [], tools: null,
    customName: `Stage ${position}`, instructions: "be careful", ...extra,
  };
}

function crew(stages: PipelineStage[], isBuiltin = false): PipelineWithStages {
  return { pipeline: { id: "p", name: "Relay", description: "d", isBuiltin, createdAt: "t" }, stages };
}

const map = supersessionMap(catalog);

describe("supersededModels", () => {
  it("maps only catalog models whose replacement is in the catalog", () => {
    expect([...map.keys()]).toEqual(["claude-fable-5-1"]);
    const dangling = supersessionMap([
      { name: "x", models: [model("old", "Old", 1, 1, "missing")] } as unknown as ProviderConfig,
    ]);
    expect(dangling.size).toBe(0);
  });

  it("detects a superseded model on a stage or only on its escalation", () => {
    expect(pipelineSupersessions(crew([stage(0, "claude-sonnet-5-5")]), map)).toEqual([]);
    expect(pipelineSupersessions(crew([stage(0, "claude-fable-5-1")]), map).map((s) => s.to.id)).toEqual([
      "claude-fable-5-2",
    ]);
    const escalationOnly = crew([stage(0, "claude-sonnet-5-5", { escalateModel: "claude-fable-5-1" })]);
    expect(pipelineSupersessions(escalationOnly, map)).toHaveLength(1);
    // Several stages on it still make one offer.
    const many = crew([stage(0, "claude-fable-5-1"), stage(1, "claude-fable-5-1", { escalateModel: "claude-fable-5-1" })]);
    expect(pipelineSupersessions(many, map)).toHaveLength(1);
  });

  it("says the saving from the prices and nothing about quality", () => {
    const s = map.get("claude-fable-5-1")!;
    expect(supersededLine(s)).toBe("Fable 5.1 → Fable 5.2: about 20% cheaper per token.");
    expect(supersededLine(s)).not.toMatch(/tier|same|quality/i);
    expect(keepLabel(s)).toBe("Keep 5.1");
    // A replacement made pricier by an edited price gets no offer.
    expect(savingPercent({ from: s.from, to: { ...s.to, outputCostPerM: 60 } })).toBeNull();
    expect(supersededLine({ from: s.from, to: { ...s.to, inputCostPerM: 10 } })).toBeNull();
  });

  it("switches every stage and escalation on the old model, and nothing else", () => {
    const p = crew([
      stage(1, "claude-sonnet-5-5", { escalateModel: "claude-fable-5-1", substrate: "cli" }),
      stage(0, "claude-fable-5-1", { escalateModel: "claude-sonnet-5-5" }),
      stage(2, "claude-fable-5-1", { escalateModel: "claude-fable-5-1", tools: ["read_file"] }),
    ]);
    const draft = switchedDraft(p, "claude-fable-5-1", "claude-fable-5-2");
    expect(draft.pipelineId).toBe("p");
    expect(draft.name).toBe("Relay");
    expect(draft.stages.map((s) => [s.agentModel, s.escalateModel])).toEqual([
      ["claude-fable-5-2", "claude-sonnet-5-5"],
      ["claude-sonnet-5-5", "claude-fable-5-2"],
      ["claude-fable-5-2", "claude-fable-5-2"],
    ]);
    // Everything but the model ids is saved as it was.
    const { agentModel: _a, escalateModel: _e, ...rest } = draft.stages[2];
    expect(rest).toEqual({
      role: "implement", effort: "high", escalateEffort: null, substrate: "api", checkpoint: false,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25, posX: 20, posY: 5,
      parents: [1], tools: ["read_file"], customName: "Stage 2", instructions: "be careful",
    });
  });

  it("forks a builtin under the builder's copy name", () => {
    const draft = switchedDraft(crew([stage(0, "claude-fable-5-1")], true), "claude-fable-5-1", "claude-fable-5-2");
    expect(draft).toMatchObject({ pipelineId: "p", name: "Relay (custom)" });
  });

  it("knows when a Claude Code stage would move", () => {
    expect(supersededOnCli(crew([stage(0, "claude-fable-5-1")]), "claude-fable-5-1")).toBe(false);
    const cli = crew([stage(0, "claude-sonnet-5-5", { substrate: "cli", escalateModel: "claude-fable-5-1" })]);
    expect(supersededOnCli(cli, "claude-fable-5-1")).toBe(true);
  });
});

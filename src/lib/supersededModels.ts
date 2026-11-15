// Models the catalog marks as replaced (`ModelInfo.supersededBy`, set in
// `provider_router::builtin_providers` — today only Fable 5.1 → Fable 5.2).
// Pipelines name model ids explicitly, so a crew built on a replaced model
// stays on it; the Direct launcher offers the switch and never makes it.
import type { PipelineDraft, PipelineStage, PipelineWithStages, StageDraft } from "./ipc";
import type { ModelInfo, ProviderConfig } from "./types";

export interface Supersession {
  from: ModelInfo;
  to: ModelInfo;
}

/** Superseded id → the model that replaces it. Both must be in the catalog;
 *  the first provider listing an id wins. */
export function supersessionMap(providers: ProviderConfig[]): Map<string, Supersession> {
  const byId = new Map<string, ModelInfo>();
  for (const p of providers) for (const m of p.models) if (!byId.has(m.id)) byId.set(m.id, m);
  const out = new Map<string, Supersession>();
  for (const from of byId.values()) {
    const to = from.supersededBy ? byId.get(from.supersededBy) : undefined;
    if (to && to.id !== from.id) out.set(from.id, { from, to });
  }
  return out;
}

const stageModels = (s: PipelineStage) => [s.agentModel, s.escalateModel ?? ""];

/** The supersessions a pipeline's stages use, as their model or their
 *  escalation model — each once, in stage order. */
export function pipelineSupersessions(pipeline: PipelineWithStages, map: Map<string, Supersession>): Supersession[] {
  const ids = [...pipeline.stages]
    .sort((a, b) => a.position - b.position)
    .flatMap(stageModels)
    .filter((id) => map.has(id));
  return [...new Set(ids)].map((id) => map.get(id)!);
}

/** "Claude Fable 5.1" → "Fable 5.1". */
export function shortModelName(m: ModelInfo): string {
  return (m.displayName || m.id).replace(/^Claude\s+/, "");
}

/** Whole percent the replacement saves per input token, or null unless it
 *  is cheaper on both input and output (an edited price can undo that). */
export function savingPercent({ from, to }: Supersession): number | null {
  if (!(from.inputCostPerM > 0 && from.outputCostPerM > 0)) return null;
  if (!(to.inputCostPerM < from.inputCostPerM && to.outputCostPerM < from.outputCostPerM)) return null;
  const pct = Math.round((1 - to.inputCostPerM / from.inputCostPerM) * 100);
  return pct > 0 ? pct : null;
}

/** "Fable 5.1 → Fable 5.2: about 20% cheaper per token." — null when the
 *  replacement isn't cheaper. Says nothing about quality on purpose. */
export function supersededLine(s: Supersession): string | null {
  const pct = savingPercent(s);
  if (pct == null) return null;
  return `${shortModelName(s.from)} → ${shortModelName(s.to)}: about ${pct}% cheaper per token.`;
}

/** "Keep 5.1" — the version part of the superseded model's name. */
export function keepLabel(s: Supersession): string {
  return `Keep ${shortModelName(s.from).split(/\s+/).pop()}`;
}

function toDraft(s: PipelineStage, fromIds: readonly string[], toId: string): StageDraft {
  const swap = (id: string) => (fromIds.includes(id) ? toId : id);
  return {
    role: s.role,
    agentModel: swap(s.agentModel),
    effort: s.effort ?? null,
    escalateModel: s.escalateModel ? swap(s.escalateModel) : null,
    escalateEffort: s.escalateEffort ?? null,
    substrate: s.substrate,
    checkpoint: s.checkpoint,
    loopTargetPosition: s.loopTargetPosition,
    loopMaxIterations: s.loopMaxIterations,
    loopMode: s.loopMode,
    maxIterations: s.maxIterations,
    posX: s.posX,
    posY: s.posY,
    parents: s.parents ?? [],
    tools: s.tools,
    customName: s.customName,
    instructions: s.instructions,
  };
}

/** The save that moves every stage of this pipeline on `fromId` (or any of
 *  several ids) — model and escalation model — to `toId`, leaving everything
 *  else as saved. A builtin is forked under the name the builder gives its copy. */
export function switchedDraft(pipeline: PipelineWithStages, fromId: string | readonly string[], toId: string): PipelineDraft {
  const { id, name, description, isBuiltin } = pipeline.pipeline;
  const fromIds = typeof fromId === "string" ? [fromId] : fromId;
  return {
    pipelineId: id,
    name: isBuiltin ? `${name} (custom)` : name,
    description,
    stages: [...pipeline.stages].sort((a, b) => a.position - b.position).map((s) => toDraft(s, fromIds, toId)),
  };
}

/** True when a stage on `fromId` runs on Claude Code (a CLI stage), where the
 *  replacement may need a newer CLI. */
export function supersededOnCli(pipeline: PipelineWithStages, fromId: string): boolean {
  return pipeline.stages.some((s) => s.substrate === "cli" && stageModels(s).includes(fromId));
}

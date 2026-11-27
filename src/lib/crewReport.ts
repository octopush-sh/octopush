// The crew report card (#983): copy and edits for the per-stage track record
// and the right-sizing suggestions `get_crew_report` returns. The rules live
// in Rust (`orchestrator/crew_report.rs`); nothing here decides, it only words
// a suggestion and builds the one pipeline edit it offers.
import type { CrewSuggestion, PipelineDraft, PipelineStage, PipelineWithStages, Role, StageDraft, StageOutcome } from "./ipc";
import { formatEstimateUsd, formatUsd } from "./cost";
import { toDraft } from "./supersededModels";

/** A stage's name: its custom name, else its role's label. */
export function stageName(stage: Pick<PipelineStage, "role" | "customName"> | undefined, roles: Role[], role = ""): string {
  const custom = stage?.customName?.trim();
  if (custom) return custom;
  const key = stage?.role ?? role;
  return roles.find((r) => r.key === key)?.label ?? key;
}

const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
const times = (v: number) => `${v.toFixed(1)}×`;

/** "Plan escalates in 7 of 10 runs" — the launcher line's subject. */
export function suggestionHeadline(s: CrewSuggestion, name: string, sender: string): string {
  switch (s.kind) {
    case "startStrong":
      return `${name} escalates in ${s.count} of ${s.runs} runs`;
    case "lighterTier":
      return `${name} passed first time in ${s.count} of ${s.runs} runs`;
    case "loopHotspot":
      return `${sender} sends ${name} back ${times(s.meanLoops ?? 0)} per run`;
  }
}

/** "1 suggestion · Plan escalates in 7 of 10 runs" */
export function suggestionLine(all: CrewSuggestion[], headline: string): string {
  return `${all.length} ${all.length === 1 ? "suggestion" : "suggestions"} · ${headline}`;
}

/** The suggestion in full, every dollar figure labelled an estimate and
 *  left out when a model is unpriced. */
export function suggestionDetail(s: CrewSuggestion, name: string, sender: string): string {
  const saving = s.savingUsd != null && s.savingUsd > 0 ? s.savingUsd : null;
  switch (s.kind) {
    case "startStrong":
      return saving != null
        ? `Escalated in ${s.count} of ${s.runs} runs. Starting on ${s.modelLabel} would have cost about ${formatEstimateUsd(saving)} less per run (estimate).`
        : `Escalated in ${s.count} of ${s.runs} runs, each paying for the earlier attempts and then for ${s.modelLabel}.`;
    case "lighterTier":
      return `Passed first time in ${s.count} of ${s.runs} runs. Try ${s.modelLabel} here; ${s.escalateLabel} stays as the escalation.${
        saving != null ? ` About ${formatEstimateUsd(saving)} less per run (estimate).` : ""
      }`;
    case "loopHotspot":
      return `${sender} sent ${name} back ${times(s.meanLoops ?? 0)} per run. Its effort, its instructions or a plan gate are the levers.`;
  }
}

/** The upright-serif phrase that offers the edit. */
export function suggestionCta(s: CrewSuggestion, name: string): string {
  switch (s.kind) {
    case "startStrong":
      return `Start ${name} on ${s.modelLabel}`;
    case "lighterTier":
      return `Try ${s.modelLabel} on ${name}`;
    case "loopHotspot":
      return "Open this crew in the builder";
  }
}

/** What the confirm says will change. */
export function suggestionConfirm(s: CrewSuggestion, name: string, builtin: boolean): string {
  const change =
    s.kind === "startStrong"
      ? `${name} starts on ${s.modelLabel} and no longer switches model when it escalates.`
      : `${name} runs on ${s.modelLabel}, and escalates to ${s.escalateLabel} if it fails.`;
  return `${change} ${builtin ? "Saves a copy of this crew." : "You can change it back in the builder."}`;
}

/** The stage fields a suggestion changes (none for a loop hotspot). The
 *  lighter tier always carries an escalation model: the safety net stays. */
export function suggestionPatch(s: CrewSuggestion): Partial<Pick<StageDraft, "agentModel" | "escalateModel">> | null {
  if (!s.model) return null;
  if (s.kind === "startStrong") return { agentModel: s.model, escalateModel: null };
  if (s.kind === "lighterTier" && s.escalateModel) return { agentModel: s.model, escalateModel: s.escalateModel };
  return null;
}

/** The save that applies a suggestion to its stage and leaves the rest as
 *  saved. A builtin is forked under the name the builder gives its copy. */
export function suggestionDraft(pipeline: PipelineWithStages, s: CrewSuggestion): PipelineDraft | null {
  const patch = suggestionPatch(s);
  if (!patch) return null;
  const { id, name, description, isBuiltin } = pipeline.pipeline;
  return {
    pipelineId: id,
    name: isBuiltin ? `${name} (custom)` : name,
    description,
    stages: [...pipeline.stages]
      .sort((a, b) => a.position - b.position)
      .map((st) => (st.position === s.position ? { ...toDraft(st, [], ""), ...patch } : toDraft(st, [], ""))),
  };
}

/** "20 runs · first pass 85% · loops 0.3 · escalated 10% · median $0.42" */
export function trackRecordLine(o: StageOutcome): string {
  const median = o.medianUsd == null ? "median unpriced" : `median ${formatUsd(o.medianUsd)}`;
  return [
    `${o.runs} runs`,
    `first pass ${pct(o.firstPass, o.runs)}`,
    `loops ${(o.loopBacks / o.runs).toFixed(1)}`,
    `escalated ${pct(o.escalated, o.runs)}`,
    median,
  ].join(" · ");
}

/** The record's tooltip: what each figure counts, and the cost by model. */
export function trackRecordTitle(o: StageOutcome): string {
  const models = o.byModel
    .map((m) => `${m.model}: ${m.runs} ${m.runs === 1 ? "run" : "runs"}, median ${m.medianUsd == null ? "unpriced" : formatUsd(m.medianUsd)}`)
    .join("\n");
  return [
    `This Mac's latest ${o.runs} runs of this stage. First pass: done with no loop-back, escalation or halt. Loops: times a review sent it back, per run. Median: every attempt summed.`,
    o.halted > 0 ? `Halted in ${o.halted} of ${o.runs} runs.` : "",
    models,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The micro-history, oldest left: a first pass, a run that needed rework,
 *  a halt. Outcome colours only; brass means "a crew waits on you". */
export function recentDots(o: StageOutcome): { status: string; title: string }[] {
  const word = { pass: "first pass", rework: "needed rework", halt: "halted" } as const;
  return [...o.recent].reverse().map((r) => ({ status: r, title: word[r] }));
}

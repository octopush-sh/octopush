// Models with a published retirement date (`token_engine::MODEL_RETIREMENTS`,
// read through `ipc.modelRetirements`). A crew names its model ids, so one
// built on a retiring model keeps it until the provider starts refusing it;
// the Direct launcher, Readiness and Routines say so within the last
// RETIREMENT_NOTICE_DAYS and after. Nothing is ever switched for the user.
import { ipc, type ModelRetirement, type PipelineStage, type PipelineWithStages, type ReadinessCheck, type Routine } from "./ipc";

export const RETIREMENT_NOTICE_DAYS = 30;

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type RetirementPhase = { kind: "soon"; daysLeft: number } | { kind: "retired" };

function parseDay(retires: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(retires);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null;
}

/** Whole UTC days from `now`'s day to the retirement day: 0 on the day
 *  itself, negative once it has passed. Null on an unreadable date. */
export function daysUntilRetirement(retires: string, now: Date): number | null {
  const day = parseDay(retires);
  if (!day) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(day.y, day.m - 1, day.d) - today) / DAY_MS);
}

/** "soon" within the last RETIREMENT_NOTICE_DAYS (the day itself included),
 *  "retired" after it, null before the window or on an unreadable date. */
export function retirementPhase(retires: string, now: Date): RetirementPhase | null {
  const days = daysUntilRetirement(retires, now);
  if (days == null || days > RETIREMENT_NOTICE_DAYS) return null;
  return days < 0 ? { kind: "retired" } : { kind: "soon", daysLeft: days };
}

/** "Nov 30", or "Nov 30, 2026" when that isn't this year. */
export function retirementDay(retires: string, now: Date): string {
  const day = parseDay(retires);
  if (!day) return retires;
  const short = `${MONTHS[day.m - 1]} ${day.d}`;
  return day.y === now.getUTCFullYear() ? short : `${short}, ${day.y}`;
}

/** "Sonnet 4.5 retires Nov 30, so a stage on it will fail after that." /
 *  "Sonnet 4.5 retired Nov 30, so a stage on it will fail." */
export function retirementLine(r: ModelRetirement, phase: RetirementPhase, now: Date, subject: string): string {
  const day = retirementDay(r.retires, now);
  return phase.kind === "retired"
    ? `${r.label} retired ${day}, so ${subject} will fail.`
    : `${r.label} retires ${day}, so ${subject} will fail after that.`;
}

/** A retiring model a crew uses, folded over its dated and undated ids. */
export interface RetirementNotice {
  retirement: ModelRetirement;
  phase: RetirementPhase;
  /** Every id of this model the crew names. */
  ids: string[];
  /** Stages on it, as their model or their escalation model. */
  stages: number;
}

type StageModels = Pick<PipelineStage, "position" | "agentModel" | "escalateModel">;

const stageModels = (s: StageModels, overrides: Record<number, string>) =>
  [overrides[s.position] || s.agentModel, s.escalateModel ?? ""].filter(Boolean);

/** Every model a crew runs on — a stage's model (or its override) and its
 *  escalation model — each once. */
export function crewModels(stages: StageModels[], overrides: Record<number, string> = {}): string[] {
  return [...new Set(stages.flatMap((s) => stageModels(s, overrides)))];
}

/** The retiring models a crew uses that are in their notice window or past
 *  it: retired first, then the soonest. */
export function crewRetirements(
  stages: StageModels[],
  table: ModelRetirement[],
  now: Date,
  overrides: Record<number, string> = {},
): RetirementNotice[] {
  const byLabel = new Map<string, RetirementNotice>();
  for (const r of table) {
    const phase = retirementPhase(r.retires, now);
    if (!phase) continue;
    const ids = new Set([...(byLabel.get(r.label)?.ids ?? []), r.model]);
    const stagesOn = stages.filter((s) => stageModels(s, overrides).some((m) => ids.has(m))).length;
    if (stagesOn === 0) continue;
    byLabel.set(r.label, { retirement: r, phase, ids: [...ids], stages: stagesOn });
  }
  const order = (n: RetirementNotice) => (n.phase.kind === "retired" ? -1 : n.phase.daysLeft);
  return [...byLabel.values()].sort((a, b) => order(a) - order(b));
}

/** A Routine's saved per-position model overrides (`[[position, model], …]`
 *  JSON, as `routines::parse_stage_overrides` reads it); bad JSON is none. */
export function routineOverrides(json: string | null | undefined): Record<number, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return {};
    const out: Record<number, string> = {};
    for (const e of parsed) {
      if (Array.isArray(e) && typeof e[0] === "number" && typeof e[1] === "string") out[e[0]] = e[1];
    }
    return out;
  } catch {
    return {};
  }
}

/** The notice a Routine's crew gets, with the Routine's model overrides. */
export function routineRetirement(
  routine: Routine,
  pipelines: PipelineWithStages[],
  table: ModelRetirement[],
  now: Date,
): RetirementNotice | null {
  const crew = pipelines.find((p) => p.pipeline.id === routine.pipelineId);
  if (!crew) return null;
  return crewRetirements(crew.stages, table, now, routineOverrides(routine.stageOverrides))[0] ?? null;
}

/** Every model the saved crews and the Routines' overrides name — what the
 *  Readiness row asks the backend about. */
export function libraryModels(pipelines: PipelineWithStages[], routines: Routine[]): string[] {
  const ids = pipelines.flatMap((p) => crewModels(p.stages));
  for (const r of routines) {
    const crew = pipelines.find((p) => p.pipeline.id === r.pipelineId);
    if (crew) ids.push(...crewModels(crew.stages, routineOverrides(r.stageOverrides)));
  }
  return [...new Set(ids)];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The Readiness row for saved crews and Routines on a retiring model: the
 *  most urgent model, the crews and Routines that will fail. Null when none. */
export function readinessRetirementCheck(
  pipelines: PipelineWithStages[],
  routines: Routine[],
  table: ModelRetirement[],
  now: Date,
): ReadinessCheck | null {
  type Hit = { notice: RetirementNotice; crews: string[]; routines: string[] };
  const hits = new Map<string, Hit>();
  const hit = (n: RetirementNotice) => {
    const h = hits.get(n.retirement.label) ?? { notice: n, crews: [], routines: [] };
    hits.set(n.retirement.label, h);
    return h;
  };
  for (const p of pipelines) {
    for (const n of crewRetirements(p.stages, table, now)) hit(n).crews.push(p.pipeline.name);
  }
  for (const r of routines) {
    const crew = pipelines.find((p) => p.pipeline.id === r.pipelineId);
    if (!crew) continue;
    for (const n of crewRetirements(crew.stages, table, now, routineOverrides(r.stageOverrides))) hit(n).routines.push(r.name);
  }
  const order = (h: Hit) => (h.notice.phase.kind === "retired" ? -1 : h.notice.phase.daysLeft);
  const first = [...hits.values()].sort((a, b) => order(a) - order(b))[0];
  if (!first) return null;
  const { notice, crews, routines: onRoutines } = first;
  const subjects = [crews.length ? plural(crews.length, "crew") : "", onRoutines.length ? plural(onRoutines.length, "Routine") : ""]
    .filter(Boolean)
    .join(" and ");
  const names = [...crews, ...onRoutines.map((n) => `Routine ${n}`)].join(", ");
  const more = hits.size > 1 ? ` ${plural(hits.size - 1, "more model")} also retire.` : "";
  return {
    id: "models",
    label: "Crew models",
    status: notice.phase.kind === "retired" ? "fail" : "warn",
    value: `${notice.retirement.label} · ${notice.phase.kind === "retired" ? "retired" : "retires"} ${retirementDay(notice.retirement.retires, now)}`,
    fix: `${retirementLine(notice.retirement, notice.phase, now, `${subjects} on it`)} ${names}. Switch each to ${notice.retirement.replacementLabel} from the Direct launcher.${more}`,
    command: null,
    timedOut: false,
  };
}

// The table is fixed per build: each id is asked about once per session.
const cache = new Map<string, ModelRetirement | null>();

/** The retiring models among `models`, from the session cache or the
 *  backend. A failed read says nothing (and is asked again next time). */
export async function loadModelRetirements(models: string[]): Promise<ModelRetirement[]> {
  const missing = models.filter((m) => !cache.has(m));
  if (missing.length > 0) {
    const found = await Promise.resolve()
      .then(() => ipc.modelRetirements(missing))
      .catch(() => null);
    if (found) {
      for (const m of missing) cache.set(m, null);
      for (const r of found) cache.set(r.model, r);
    }
  }
  return models.map((m) => cache.get(m)).filter((r): r is ModelRetirement => !!r);
}

/** Test seam: forget the session cache. */
export function resetModelRetirementCache(): void {
  cache.clear();
}

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

/** A Routine's notice, with how it reaches the model: what fixes it differs.
 *  The launcher switch edits only the crew's stages, and forks a builtin
 *  crew the Routine keeps pointing at; the Routine's own overrides stay. */
export interface RoutineRetirementNotice extends RetirementNotice {
  crewName: string;
  /** The crew's own stage or escalation models name it. */
  viaCrew: boolean;
  builtinCrew: boolean;
  /** The Routine's stage overrides name it. */
  viaOverride: boolean;
}

function routineNotice(n: RetirementNotice, crew: PipelineWithStages, overrides: Record<number, string>): RoutineRetirementNotice {
  const ids = new Set(n.ids);
  return {
    ...n,
    crewName: crew.pipeline.name,
    viaCrew: crew.stages.some((s) => (!overrides[s.position] && ids.has(s.agentModel)) || ids.has(s.escalateModel ?? "")),
    builtinCrew: crew.pipeline.isBuiltin,
    viaOverride: crew.stages.some((s) => ids.has(overrides[s.position] ?? "")),
  };
}

/** The notices a Routine's crew gets, with the Routine's model overrides. */
function routineRetirements(
  routine: Routine,
  pipelines: PipelineWithStages[],
  table: ModelRetirement[],
  now: Date,
): RoutineRetirementNotice[] {
  const crew = pipelines.find((p) => p.pipeline.id === routine.pipelineId);
  if (!crew) return [];
  const overrides = routineOverrides(routine.stageOverrides);
  return crewRetirements(crew.stages, table, now, overrides).map((n) => routineNotice(n, crew, overrides));
}

/** The most urgent notice a Routine's crew gets, with its overrides. */
export function routineRetirement(
  routine: Routine,
  pipelines: PipelineWithStages[],
  table: ModelRetirement[],
  now: Date,
): RoutineRetirementNotice | null {
  return routineRetirements(routine, pipelines, table, now)[0] ?? null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What fixes a Routine the launcher switch alone doesn't: a builtin crew
 *  (the switch saves a copy the Routine must be pointed at) and its own
 *  overrides (the routine editor doesn't show them; a new one has none). */
function routineOnlyFixes(n: RoutineRetirementNotice, who: string): string[] {
  const out: string[] = [];
  if (n.viaCrew && n.builtinCrew) {
    out.push(
      `${n.crewName} is a built-in crew: switching it to ${n.retirement.replacementLabel} from the Direct launcher saves a copy, ${n.crewName} (custom), and ${who} keeps the built-in one until you edit it to use the copy.`,
    );
  }
  if (n.viaOverride) {
    out.push(
      `${capitalize(who)}'s own stage overrides pick ${n.retirement.label}, and the routine editor can't change them: compose it again (a new routine has none) and delete the old one.`,
    );
  }
  return out;
}

/** The Routines row tooltip: each action the app offers that fixes it. */
export function routineRetirementFix(n: RoutineRetirementNotice, who = "this routine"): string {
  const crewSwitch = n.viaCrew && !n.builtinCrew
    ? [`Switch ${who}'s crew, ${n.crewName}, to ${n.retirement.replacementLabel} from the Direct launcher.`]
    : [];
  return capitalize([...crewSwitch, ...routineOnlyFixes(n, who)].join(" "));
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
  type OnRoutine = { name: string; notice: RoutineRetirementNotice };
  type Hit = { notice: RetirementNotice; crews: string[]; routines: OnRoutine[] };
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
    for (const n of routineRetirements(r, pipelines, table, now)) hit(n).routines.push({ name: r.name, notice: n });
  }
  const order = (h: Hit) => (h.notice.phase.kind === "retired" ? -1 : h.notice.phase.daysLeft);
  const first = [...hits.values()].sort((a, b) => order(a) - order(b))[0];
  if (!first) return null;
  const { notice, crews, routines: onRoutines } = first;
  const subjects = [crews.length ? plural(crews.length, "crew") : "", onRoutines.length ? plural(onRoutines.length, "Routine") : ""]
    .filter(Boolean)
    .join(" and ");
  const names = [...crews, ...onRoutines.map((r) => `Routine ${r.name}`)].join(", ");
  // The launcher switch fixes the crews, and the Routines that only inherit
  // a custom crew's model; builtin-crew and override Routines need more.
  const fixes: string[] = [];
  if (crews.length) fixes.push(`Switch each crew to ${notice.retirement.replacementLabel} from the Direct launcher.`);
  const following = onRoutines.filter((r) => !r.notice.viaOverride && !r.notice.builtinCrew).map((r) => `Routine ${r.name}`);
  if (following.length) fixes.push(`${following.join(", ")} ${following.length === 1 ? "follows its crew" : "follow their crews"}.`);
  for (const r of onRoutines) fixes.push(...routineOnlyFixes(r.notice, `Routine ${r.name}`));
  const more = hits.size > 1 ? ` ${plural(hits.size - 1, "more model")} also retire.` : "";
  return {
    id: "models",
    label: "Crew models",
    status: notice.phase.kind === "retired" ? "fail" : "warn",
    value: `${notice.retirement.label} · ${notice.phase.kind === "retired" ? "retired" : "retires"} ${retirementDay(notice.retirement.retires, now)}`,
    fix: `${retirementLine(notice.retirement, notice.phase, now, `${subjects} on it`)} ${names}. ${fixes.join(" ")}${more}`,
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

// A run parked by a Claude plan limit (#731): the stage that hit the wall
// keeps its spend and session, and the run resumes on its own at the
// window's reset unless the director resumes early or turns that off.
// Waiting is not "needs you": no decision is required, so a scheduled park
// sits in flight and never takes the beacon.

import type { PlanWait, Run } from "./ipc";
import { resetLabel, windowName } from "./claudePlan";

/** The marker `cli_runner::apply_plan_limit` puts on a plan-limited stage error. */
export const PLAN_LIMIT_MARKER = "(plan_limit)";

/** Whether a stage error is a Claude plan limit. */
export function isPlanLimitHalt(error: string | null | undefined): boolean {
  return !!error && error.includes(PLAN_LIMIT_MARKER);
}

/** The stage the Direct canvas's decision bar acts on. A run can hold
 *  several at once (a plan limit beside a sibling's gate, halt or question):
 *  the one that needs a decision comes first, so its bar shows (and takes the
 *  beacon) instead of the calm plan wait. Plan-limited stages come last. */
export function pickBlockedStage<S extends { status: string; error?: string | null }>(stages: readonly S[]): S | null {
  const resolvable = stages.filter((s) => s.status === "awaiting_checkpoint" || s.status === "failed");
  return resolvable.find((s) => !(s.status === "failed" && isPlanLimitHalt(s.error))) ?? resolvable[0] ?? null;
}

/** The stage a plan park's Resume acts on: the first plan-limited one, as the
 *  automatic resume picks it (`plan_wait.rs`). Resuming it resumes every
 *  plan-limited stage of the run. Null once none is left. */
export function planLimitedStage<S extends { status: string; error?: string | null }>(stages: readonly S[]): S | null {
  return stages.find((s) => s.status === "failed" && isPlanLimitHalt(s.error)) ?? null;
}

/** Automatic resumes before a plan-parked run waits for the director. Mirrors
 *  `plan_wait::AUTO_RESUME_CAP` in Rust; `planWait.test.ts` pins the two. */
export const AUTO_RESUME_CAP = 3;

/** Stale reports in a row resumed on their own before the run waits for the
 *  director. Mirrors `plan_wait::STALE_RESUMES`; `planWait.test.ts` pins it. */
export const STALE_RESUMES = 1;

/** Claude Code reported a limit that had already reset, again (#1109): the
 *  run waits for the director instead of spending its automatic resumes. */
function staleReported(w: PlanWait): boolean {
  return w.resumeAt == null && (w.staleCount ?? 0) > STALE_RESUMES;
}

/** A paused run waiting for its plan to reset, with an automatic resume
 *  scheduled, and nothing else in it waiting for the director: only then is
 *  it calm. A sibling's real halt, gate or question keeps it needs-you. */
export function isPlanWaiting(run: Pick<Run, "status" | "planWait">): boolean {
  const w = run.planWait;
  return run.status === "paused" && w?.resumeAt != null && !w.otherHold;
}

/** Mission Control's live line: `plan limit · resumes 19:40`, or, when the
 *  director resumes, `plan limit · resets 19:40`. Null for any other run. */
export function planWaitLine(run: Pick<Run, "status" | "planWait">, nowMs: number): string | null {
  const w = run.planWait;
  if (run.status !== "paused" || !w) return null;
  if (w.resumeAt != null) return `plan limit · resumes ${resetLabel(w.resumeAt, nowMs)}`;
  if (staleReported(w)) return "plan limit · already reset";
  return `plan limit · resets ${resetLabel(w.resetsAt, nowMs)}`;
}

/** The decision bar's sentence after the stage name. */
export function planWaitSentence(run: Pick<Run, "status" | "planWait">, nowMs: number): string {
  const w = run.planWait;
  if (!w) return "paused by your Claude plan";
  if (w.resumeAt != null) return `paused by your Claude plan · resumes at ${resetLabel(w.resumeAt, nowMs)}`;
  if (staleReported(w)) return "paused by a plan limit that had already reset";
  return `paused by your Claude plan · the ${windowName(w.window)} resets at ${resetLabel(w.resetsAt, nowMs)}`;
}

/** Why a plan-parked run waits for the director instead of resuming itself. */
export function planWaitWhy(run: Pick<Run, "planWait" | "budgetUsd" | "costUsd">): string {
  const w = run.planWait;
  if (!w || w.resumeAt != null) {
    return "It continues the same session once your plan's window resets. Nothing you approved is skipped.";
  }
  // The drive's budget gate: a budget of 0 is no budget.
  if (run.budgetUsd != null && run.budgetUsd > 0 && run.costUsd >= run.budgetUsd) {
    return "The run's budget is spent, so it doesn't resume on its own. Resume it when you're ready.";
  }
  // `plan_wait::STALE_REPORT_NOTICE`, word for word.
  if (staleReported(w)) {
    return "Claude Code reported a plan limit that had already reset. Claude Code 2.1.332 fixes this. Update Claude Code, then Resume.";
  }
  if (w.resumeCount >= AUTO_RESUME_CAP) {
    return `It hit the limit again after ${AUTO_RESUME_CAP} automatic resumes, so it waits for you.`;
  }
  return "It doesn't resume on its own. Resume it when you're ready.";
}

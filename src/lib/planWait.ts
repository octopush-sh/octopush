// A run parked by a Claude plan limit (#731): the stage that hit the wall
// keeps its spend and session, and the run resumes on its own at the
// window's reset unless the director resumes early or turns that off.
// Waiting is not "needs you": no decision is required, so a scheduled park
// sits in flight and never takes the beacon.

import type { Run } from "./ipc";
import { resetLabel, windowName } from "./claudePlan";

/** The marker `cli_runner::apply_plan_limit` puts on a plan-limited stage error. */
export const PLAN_LIMIT_MARKER = "(plan_limit)";

/** Whether a stage error is a Claude plan limit. */
export function isPlanLimitHalt(error: string | null | undefined): boolean {
  return !!error && error.includes(PLAN_LIMIT_MARKER);
}

/** Automatic resumes before a plan-parked run waits for the director. Mirrors
 *  `plan_wait::AUTO_RESUME_CAP` in Rust; `planWait.test.ts` pins the two. */
export const AUTO_RESUME_CAP = 3;

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
  return `plan limit · resets ${resetLabel(w.resetsAt, nowMs)}`;
}

/** The decision bar's sentence after the stage name. */
export function planWaitSentence(run: Pick<Run, "status" | "planWait">, nowMs: number): string {
  const w = run.planWait;
  if (!w) return "paused by your Claude plan";
  if (w.resumeAt != null) return `paused by your Claude plan · resumes at ${resetLabel(w.resumeAt, nowMs)}`;
  return `paused by your Claude plan · the ${windowName(w.window)} resets at ${resetLabel(w.resetsAt, nowMs)}`;
}

/** Why a plan-parked run waits for the director instead of resuming itself. */
export function planWaitWhy(run: Pick<Run, "planWait" | "budgetUsd" | "costUsd">): string {
  const w = run.planWait;
  if (!w || w.resumeAt != null) {
    return "It continues the same session once your plan's window resets. Nothing you approved is skipped.";
  }
  if (run.budgetUsd != null && run.costUsd >= run.budgetUsd) {
    return "The run's budget is spent, so it doesn't resume on its own. Resume it when you're ready.";
  }
  if (w.resumeCount >= AUTO_RESUME_CAP) {
    return `It hit the limit again after ${AUTO_RESUME_CAP} automatic resumes, so it waits for you.`;
  }
  return "It doesn't resume on its own. Resume it when you're ready.";
}

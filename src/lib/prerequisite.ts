// "Starts after" (#960): when a waiting mission's prerequisite is met, and
// how the wait reads in the rail and on Mission Control.
import type { PrerequisiteCondition, Run, RunStage } from "./ipc";
import type { Pr } from "./types";

/** Why a mission keeps waiting although its prerequisite's run stopped. */
export type PrerequisiteHold = "halted" | "aborted" | "failed";

export type PrerequisiteVerdict = { met: true } | { met: false; hold: PrerequisiteHold | null };

const WAITING: PrerequisiteVerdict = { met: false, hold: null };

/** `run_finished`: the prerequisite's newest run (`run`, drafts skipped by
 *  the caller) went past its last gate — it completed, or every gated stage
 *  of a run still at work is done. A halted (a stage failed), aborted or
 *  failed run is no start: the mission keeps waiting, and says why. */
export function runVerdict(run: Run | null | undefined, stages: readonly RunStage[]): PrerequisiteVerdict {
  if (!run || run.status === "draft") return WAITING;
  if (run.status === "completed") return { met: true };
  if (run.status === "aborted" || run.status === "failed") return { met: false, hold: run.status };
  if (stages.some((s) => s.status === "failed")) return { met: false, hold: "halted" };
  const gates = stages.filter((s) => s.checkpoint);
  if (gates.length > 0 && gates.every((s) => s.status === "done")) return { met: true };
  return WAITING;
}

/** `pr_merged`: the prerequisite's pull request is merged. */
export function prVerdict(pr: Pr | null | undefined): PrerequisiteVerdict {
  return pr?.state === "merged" ? { met: true } : WAITING;
}

/** "Starts after auth-flow's run passes its last gate", plus why it still
 *  waits when that run stopped. */
export function waitingLine(
  condition: PrerequisiteCondition,
  afterName: string,
  hold: PrerequisiteHold | null = null,
): string {
  const base =
    condition === "pr_merged"
      ? `Starts after ${afterName}'s pull request merges`
      : `Starts after ${afterName}'s run passes its last gate`;
  if (!hold || condition !== "run_finished") return base;
  const what = hold === "halted" ? "halted" : hold === "aborted" ? "was aborted" : "failed";
  return `${base}. That run ${what}, so this mission keeps waiting`;
}

/** "auth-flow's pull request merged.": the met condition, as a sentence. */
export function metReason(condition: PrerequisiteCondition, afterName: string): string {
  return condition === "pr_merged"
    ? `${afterName}'s pull request merged.`
    : `${afterName}'s run passed its last gate.`;
}

/** A met mission queued behind another mission's seed in the one launcher
 *  slot: it is staged once that seed is taken, i.e. once `seededName` is
 *  opened in Direct (null: a seed any launcher takes). */
export function queuedLine(condition: PrerequisiteCondition, afterName: string, seededName: string | null): string {
  const where = seededName ? `you open ${seededName} in Direct` : "you open a launcher in Direct";
  return `${metReason(condition, afterName)} Ready to start once ${where}`;
}

/** What a staged start put in the launcher, and what's left to do. */
export function stagedText(seededTask: boolean, seededCrew: boolean): string {
  if (seededTask && seededCrew) return "Its brief and crew wait in Direct for Begin the run.";
  if (seededTask) return "Its brief waits in Direct; choose a crew to begin the run.";
  if (seededCrew) return "Its crew waits in Direct; write a brief to begin the run.";
  return "Open it in Direct to write a brief and choose a crew.";
}

/** Why an auto-start link didn't begin its run: what it lacked, or a refusal. */
export function notStartedText(hasTask: boolean, hasCrew: boolean): string {
  const missing = !hasTask && !hasCrew ? "brief or crew" : !hasTask ? "brief" : !hasCrew ? "crew" : null;
  return missing ? `It has no ${missing} to start on its own.` : "It didn't start on its own.";
}

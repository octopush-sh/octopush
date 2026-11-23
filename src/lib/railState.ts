import type { Run } from "./ipc";
import type { Pr, WorkspaceGitSummary } from "./types";
import { needsYou } from "./runStatus";
import { isPlanWaiting } from "./planWait";

/** The rail's state filter (#963): what a mission is doing right now. */
export type MissionState = "needs-you" | "working" | "idle";

/** The filter's choices, in the order the menu lists them. */
export const MISSION_STATES: readonly { id: MissionState; label: string }[] = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];

type RunLike = Pick<Run, "status" | "planWait">;

/**
 * What a mission's crews say, on the fleet chip's terms (`fleetCounts`) so
 * the rail, the chip and Mission Control agree: a run `needsYou` → needs you;
 * else a run in flight (running, or parked on a Claude plan with a resume
 * scheduled) → working; else idle.
 */
export function runsState(runs: readonly RunLike[] | undefined): MissionState {
  if (runs?.some(needsYou)) return "needs-you";
  if (runs?.some((r) => r.status === "running" || isPlanWaiting(r))) return "working";
  return "idle";
}

/** A mission's state: its crews' (`runsState`), raised to working while
 *  anything else works in it (the rail's marching edge: chat, terminal). */
export function missionState(runState: MissionState | undefined, running: boolean | undefined): MissionState {
  const state = runState ?? "idle";
  return state === "idle" && running ? "working" : state;
}

/** `runsState` per workspace that has runs, for a shallow-compared store
 *  selector: a cost tick on a run changes no entry, so it re-renders nothing. */
export function runStatesByWs(runsByWs: Record<string, readonly RunLike[]>): Record<string, MissionState> {
  const out: Record<string, MissionState> = {};
  for (const [id, runs] of Object.entries(runsByWs)) out[id] = runsState(runs);
  return out;
}

/**
 * The merged PR of a mission the rail may offer to archive, or null. The
 * backend vouched that the PR merged at the worktree's HEAD and the worktree
 * was clean (`mergedPrByWs`); the rail also holds back while the branch has an
 * open PR again, while the latest git summary says it changed, and while the
 * mission is not idle.
 */
export function archivableMerge(
  workspaceId: string,
  state: MissionState,
  mergedPrByWs: Record<string, Pr> | undefined,
  prByWs: Record<string, Pr | null> | undefined,
  gitSummaryByWs: Record<string, WorkspaceGitSummary> | undefined,
): Pr | null {
  const merged = mergedPrByWs?.[workspaceId];
  if (!merged || state !== "idle") return null;
  if (prByWs?.[workspaceId]) return null;
  const summary = gitSummaryByWs?.[workspaceId];
  if (summary && (summary.dirty || summary.ahead > 0)) return null;
  return merged;
}

/** The confirm's body for "Archive merged missions…": the missions by name
 *  (the first eight, then how many more), then what archiving does. */
export function archiveMergedBody(names: readonly string[]): string {
  const shown = names.slice(0, 8);
  const more = names.length - shown.length;
  const list =
    more > 0
      ? `${shown.join(", ")} and ${more} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
        : (shown[0] ?? "");
  const one = names.length === 1;
  return `${list}: ${one ? "its PR is merged and its worktree is clean" : "their PRs are merged and their worktrees are clean"}. Archiving removes ${one ? "the worktree" : "the worktrees"} and keeps ${one ? "the branch" : "the branches"}; the notice that follows can undo it.`;
}

/** The missions among `workspaces` the rail offers to archive, in order: the
 *  project menu's "Archive merged missions…" lists exactly the rows that say
 *  "merged · archive?". */
export function archivableMissions<W extends { id: string }>(
  workspaces: readonly W[],
  runStateByWs: Record<string, MissionState> | undefined,
  runningByWs: Record<string, boolean> | undefined,
  mergedPrByWs: Record<string, Pr> | undefined,
  prByWs: Record<string, Pr | null> | undefined,
  gitSummaryByWs: Record<string, WorkspaceGitSummary> | undefined,
): W[] {
  return workspaces.filter((w) => {
    const state = missionState(runStateByWs?.[w.id], runningByWs?.[w.id]);
    return archivableMerge(w.id, state, mergedPrByWs, prByWs, gitSummaryByWs) !== null;
  });
}

import type { Run } from "./ipc";

/**
 * Whether a workspace has a DIRECT run actively processing — strictly status
 * "running". A "paused" run is a checkpoint waiting on the user (it belongs to
 * the "needs attention" world, not "processing"), and draft/completed/aborted/
 * failed are not in flight. This is the rail's marching-bar signal for DIRECT.
 */
export function hasActiveDirectRun(runs: Run[] | undefined): boolean {
  return (runs ?? []).some((r) => r.status === "running");
}

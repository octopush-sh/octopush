// Law 2 of the Direct beauty redesign: at any moment there is exactly ONE
// pulsing live element per attention scope — the answer to "where do I
// look?". This pure selector owns the priority; components only ask
// whether they are the anchor. Spec §2.
//
// Priority: pending decision (checkpoint / halt / draft launch) → running
// stage card → ready launcher CTA → calm (null).
//
// The selector says nothing about colour; the components do. A needs-you
// anchor (decision, launcher) pulses in brass. A running stage is never
// brass, even as the beacon: RunFlow adds `.octo-stage-pulse-running`, which
// pulses in verdigris (#749). Under prefers-reduced-motion the pulse becomes
// a static halo that follows `--pulse-halo` — brass-dim by default,
// verdigris-strong on a running stage (styles.css, design-system §6).
//
// A run waiting for its Claude plan to reset, with an automatic resume
// scheduled, has no decision pending: calm (#731) — ringing the beacon for
// a wait trains users to ignore it. Only the plan-limited stage is calm: a
// blocked stage that is a real halt, a gate or a question still takes it.

import { isPlanLimitHalt } from "./planWait";

export type BeaconAnchor =
  | { kind: "decision" }
  | { kind: "stage"; stageId: string }
  | { kind: "launcher" }
  | null;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "aborted", "failed"]);

export function beaconAnchor(opts: {
  run: { status: string } | null;
  blockedStage: { id: string; error?: string | null } | null;
  runningStage: { id: string } | null;
  launcherReady: boolean;
  /** The run waits for its plan to reset with an automatic resume scheduled
   *  and nothing else waits for the director (`isPlanWaiting`). */
  planWaiting?: boolean;
}): BeaconAnchor {
  const { run, blockedStage, runningStage, launcherReady, planWaiting = false } = opts;
  const active = run !== null && !TERMINAL.has(run.status);
  const calmWait = planWaiting && (!blockedStage || isPlanLimitHalt(blockedStage.error));
  if (active && calmWait) return null;
  if (active && (blockedStage || run.status === "draft")) {
    return { kind: "decision" };
  }
  if (active && runningStage) {
    return { kind: "stage", stageId: runningStage.id };
  }
  if (!run && launcherReady) return { kind: "launcher" };
  return null;
}

/**
 * Nearest visible ancestor: where a signal shows when its owner is folded
 * away. `ancestors` are the foldable containers around the owner, outermost
 * first (in the rail: the project, then the mission group). A folded container
 * hides everything under it, so the signal rides on the OUTERMOST folded one,
 * the only one of them still on screen. Null means none is folded and the
 * owner carries its own signal.
 *
 * This is what keeps Law 2 true through a fold: the pulse moves to exactly one
 * visible element and never disappears with a row that stopped being drawn.
 */
export function nearestVisibleAncestor<T extends { folded: boolean }>(ancestors: readonly T[]): T | null {
  return ancestors.find((a) => a.folded) ?? null;
}

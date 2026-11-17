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

export type BeaconAnchor =
  | { kind: "decision" }
  | { kind: "stage"; stageId: string }
  | { kind: "launcher" }
  | null;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "aborted", "failed"]);

export function beaconAnchor(opts: {
  run: { status: string } | null;
  blockedStage: { id: string } | null;
  runningStage: { id: string } | null;
  launcherReady: boolean;
}): BeaconAnchor {
  const { run, blockedStage, runningStage, launcherReady } = opts;
  const active = run !== null && !TERMINAL.has(run.status);
  if (active && (blockedStage || run.status === "draft")) {
    return { kind: "decision" };
  }
  if (active && runningStage) {
    return { kind: "stage", stageId: runningStage.id };
  }
  if (!run && launcherReady) return { kind: "launcher" };
  return null;
}

// Law 2 of the Direct beauty redesign: at any moment there is exactly ONE
// brass-accented live element per attention scope — the answer to "where do
// I look?". This pure selector owns the priority; components only ask
// whether they are the anchor. Spec §2.
//
// Priority: pending decision (checkpoint / halt / draft launch) → running
// stage card → ready launcher CTA → calm (null).

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

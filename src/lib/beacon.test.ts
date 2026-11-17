import { describe, it, expect } from "vitest";
import { beaconAnchor } from "./beacon";

const running = { status: "running" } as any;

describe("beaconAnchor — exactly one brass beacon", () => {
  it("a pending decision outranks the running stage", () => {
    expect(
      beaconAnchor({ run: running, blockedStage: { id: "g" } as any, runningStage: { id: "s" } as any, launcherReady: true }),
    ).toEqual({ kind: "decision" });
  });

  it("a draft run's launch CTA is the decision", () => {
    expect(
      beaconAnchor({ run: { status: "draft" } as any, blockedStage: null, runningStage: null, launcherReady: false }),
    ).toEqual({ kind: "decision" });
  });

  it("with no decision pending, the running stage carries the beacon", () => {
    expect(
      beaconAnchor({ run: running, blockedStage: null, runningStage: { id: "s2" } as any, launcherReady: false }),
    ).toEqual({ kind: "stage", stageId: "s2" });
  });

  it("a terminal run is calm even with a failed stage row", () => {
    expect(
      beaconAnchor({ run: { status: "failed" } as any, blockedStage: { id: "x" } as any, runningStage: null, launcherReady: false }),
    ).toBeNull();
  });

  it("no run: the launcher CTA pulses only when ready", () => {
    expect(beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: true })).toEqual({ kind: "launcher" });
    expect(beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: false })).toBeNull();
  });

  it("a paused run with a blocked stage still surfaces the decision", () => {
    expect(
      beaconAnchor({ run: { status: "paused" } as any, blockedStage: { id: "g" } as any, runningStage: null, launcherReady: false }),
    ).toEqual({ kind: "decision" });
  });

  it("a paused run with a running stage and no block keeps the stage beacon", () => {
    expect(
      beaconAnchor({ run: { status: "paused" } as any, blockedStage: null, runningStage: { id: "s3" } as any, launcherReady: false }),
    ).toEqual({ kind: "stage", stageId: "s3" });
  });

  it("a run waiting for its Claude plan to reset never takes the beacon", () => {
    const run = { status: "paused" } as any;
    const blocked = { id: "halted" } as any;
    expect(beaconAnchor({ run, blockedStage: blocked, runningStage: null, launcherReady: false, planWaiting: true })).toBeNull();
    // Once the director must resume it (cap reached, budget spent, resume off), it is a decision again.
    expect(beaconAnchor({ run, blockedStage: blocked, runningStage: null, launcherReady: false, planWaiting: false })).toEqual({ kind: "decision" });
  });
});

import { describe, it, expect } from "vitest";
import {
  AUTO_RESUME_CAP,
  STALE_RESUMES,
  isPlanWaiting,
  pickBlockedStage,
  planLimitedStage,
  planWaitLine,
  planWaitSentence,
  planWaitWhy,
} from "./planWait";
import { beaconAnchor } from "./beacon";
import type { PlanWait } from "./ipc";

function wait(over: Partial<PlanWait> = {}): PlanWait {
  return { window: "five_hour", resetsAt: 1_793_551_200, resumeAt: 1_793_551_290, resumeCount: 0, otherHold: false, ...over };
}

describe("planWait", () => {
  it("shares the automatic-resume cap with the Rust scheduler", async () => {
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const rust: string = fs.readFileSync("src-tauri/src/orchestrator/plan_wait.rs", "utf8");
    const m = rust.match(/pub const AUTO_RESUME_CAP: i64 = (\d+);/);
    expect(m, "AUTO_RESUME_CAP in plan_wait.rs").not.toBeNull();
    expect(Number(m![1])).toBe(AUTO_RESUME_CAP);
  });

  it("finds the plan-limited stage a Resume acts on, past a gate or a real halt", () => {
    const plan = { id: "p", status: "failed", error: "Paused by your Claude plan.\n(plan_limit)" };
    expect(planLimitedStage([{ id: "g", status: "awaiting_checkpoint" }, { id: "h", status: "failed", error: "the build broke" }, plan])).toBe(plan);
    expect(planLimitedStage([{ id: "g", status: "awaiting_checkpoint" }])).toBeNull();
    // A plan-limited stage that already re-runs is no longer one to resume.
    expect(planLimitedStage([{ ...plan, status: "running" }])).toBeNull();
  });

  it("is calm only when the plan-limited stages are all that wait", () => {
    expect(isPlanWaiting({ status: "paused", planWait: wait() })).toBe(true);
    // A sibling's real halt, gate or question: the run needs you.
    expect(isPlanWaiting({ status: "paused", planWait: wait({ otherHold: true }) })).toBe(false);
    // No resume scheduled: the director resumes.
    expect(isPlanWaiting({ status: "paused", planWait: wait({ resumeAt: null }) })).toBe(false);
    expect(isPlanWaiting({ status: "running", planWait: wait() })).toBe(false);
  });

  it("a budget of 0 is no budget, like the drive gate", () => {
    const why = planWaitWhy({ planWait: wait({ resumeAt: null }), budgetUsd: 0, costUsd: 1 });
    expect(why).toBe("It doesn't resume on its own. Resume it when you're ready.");
    expect(planWaitWhy({ planWait: wait({ resumeAt: null }), budgetUsd: 1, costUsd: 1 })).toMatch(/budget is spent/);
  });

  it("puts a sibling's decision before the plan-limited stage, and that decision takes the beacon", () => {
    const plan = { id: "p", status: "failed", error: "Paused by your Claude plan\n(plan_limit)" };
    const gate = { id: "g", status: "awaiting_checkpoint", error: null };
    const halt = { id: "h", status: "failed", error: "the build broke" };
    expect(pickBlockedStage([plan, gate])?.id).toBe("g");
    expect(pickBlockedStage([plan, halt])?.id).toBe("h");
    expect(pickBlockedStage([plan])?.id).toBe("p");
    expect(pickBlockedStage([{ id: "d", status: "done", error: null }])).toBeNull();
    // otherHold: isPlanWaiting is false, and the gate is the decision.
    const run = { status: "paused" as const, planWait: wait({ otherHold: true }) };
    const blockedStage = pickBlockedStage([plan, gate]);
    expect(beaconAnchor({ run, blockedStage, runningStage: null, launcherReady: false, planWaiting: isPlanWaiting(run) }))
      .toEqual({ kind: "decision" });
  });

  it("shares the stale-report allowance and its copy with Rust", async () => {
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const rust: string = fs.readFileSync("src-tauri/src/orchestrator/plan_wait.rs", "utf8");
    expect(Number(rust.match(/pub const STALE_RESUMES: i64 = (\d+);/)![1])).toBe(STALE_RESUMES);
    const notice = rust.match(/pub const STALE_REPORT_NOTICE: &str =\s*"([^"]+)";/)![1];
    const stale = { planWait: wait({ resumeAt: null, staleCount: STALE_RESUMES + 1 }), budgetUsd: null, costUsd: 0 };
    expect(planWaitWhy(stale)).toBe(notice);
  });

  it("names a limit that had already reset, and only once it waits for the director", () => {
    const now = 1_793_551_000_000;
    const stale = { status: "paused" as const, planWait: wait({ resumeAt: null, staleCount: 2 }), budgetUsd: null, costUsd: 0 };
    expect(planWaitWhy(stale)).toMatch(/^Claude Code reported a plan limit that had already reset\. .*2\.1\.332/);
    expect(planWaitSentence(stale, now)).toBe("paused by a plan limit that had already reset");
    expect(planWaitLine(stale, now)).toBe("plan limit · already reset");
    // The first stale report resumes on its own: nothing about it to explain.
    const first = { status: "paused" as const, planWait: wait({ staleCount: 1 }), budgetUsd: null, costUsd: 0 };
    expect(isPlanWaiting(first)).toBe(true);
    expect(planWaitWhy(first)).toMatch(/^It continues the same session/);
    // A budget that is spent still says so first.
    expect(planWaitWhy({ ...stale, budgetUsd: 1, costUsd: 1 })).toMatch(/budget is spent/);
    // A build that doesn't send the count behaves as before.
    expect(planWaitWhy({ planWait: wait({ resumeAt: null }), budgetUsd: null, costUsd: 0 })).toBe(
      "It doesn't resume on its own. Resume it when you're ready.",
    );
  });

  it("names the cap when it was reached", () => {
    const why = planWaitWhy({ planWait: wait({ resumeAt: null, resumeCount: AUTO_RESUME_CAP }), budgetUsd: null, costUsd: 0 });
    expect(why).toBe(`It hit the limit again after ${AUTO_RESUME_CAP} automatic resumes, so it waits for you.`);
  });
});

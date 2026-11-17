import { describe, it, expect } from "vitest";
import { AUTO_RESUME_CAP, isPlanWaiting, planWaitWhy } from "./planWait";
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

  it("is calm only when the plan-limited stages are all that wait", () => {
    expect(isPlanWaiting({ status: "paused", planWait: wait() })).toBe(true);
    // A sibling's real halt, gate or question: the run needs you.
    expect(isPlanWaiting({ status: "paused", planWait: wait({ otherHold: true }) })).toBe(false);
    // No resume scheduled: the director resumes.
    expect(isPlanWaiting({ status: "paused", planWait: wait({ resumeAt: null }) })).toBe(false);
    expect(isPlanWaiting({ status: "running", planWait: wait() })).toBe(false);
  });

  it("names the cap when it was reached", () => {
    const why = planWaitWhy({ planWait: wait({ resumeAt: null, resumeCount: AUTO_RESUME_CAP }), budgetUsd: null, costUsd: 0 });
    expect(why).toBe(`It hit the limit again after ${AUTO_RESUME_CAP} automatic resumes, so it waits for you.`);
  });
});

import { describe, it, expect } from "vitest";
import { fleetCounts, isTransientHalt, needsYou, settledCounts } from "./runStatus";
import type { RunStatus } from "./ipc";
import { isPlanWaiting } from "./planWait";
import fixtures from "./needsYou.fixtures.json";
import transientFixtures from "./transientHalt.fixtures.json";

/** A plan park with (`true`) or without (`false`) a scheduled resume. */
function planWaitFor(scheduled: boolean) {
  return { window: "five_hour", resetsAt: 1_793_551_200, resumeAt: scheduled ? 1_793_551_290 : null, resumeCount: 0, otherHold: false };
}

describe("needsYou parity with the Dock badge (Rust fleet_status)", () => {
  it("answers each status as the shared fixture says", () => {
    for (const c of fixtures.statuses) {
      expect(needsYou({ status: c.status as RunStatus }), c.status).toBe(c.needsYou);
    }
  });

  it("answers each plan-waiting case as the shared fixture says", () => {
    for (const c of fixtures.planWaiting) {
      const run = { status: c.status as RunStatus, planWait: planWaitFor(c.planWaiting) };
      expect(needsYou(run), `${c.status} ${c.planWaiting}`).toBe(c.needsYou);
    }
  });

  it("is calm only when the plan-limited stages are all that wait, as the shared fixture says", () => {
    for (const c of fixtures.planWait) {
      const run = {
        status: c.status as RunStatus,
        planWait: { window: "five_hour", resetsAt: 1_793_551_200, resumeAt: c.resumeAt, resumeCount: 0, otherHold: c.otherHold },
      };
      const label = `${c.status} resumeAt=${c.resumeAt} otherHold=${c.otherHold}`;
      expect(isPlanWaiting(run), label).toBe(c.planWaiting);
      expect(needsYou(run), label).toBe(c.needsYou);
    }
  });

  it("splits each fleet as the shared fixture says", () => {
    for (const f of fixtures.fleets) {
      const waiting = (f as { planWaiting?: boolean[] }).planWaiting;
      const counts = fleetCounts(
        f.statuses.map((status, i) => ({ status: status as RunStatus, planWait: planWaitFor(waiting?.[i] ?? false) })),
      );
      expect(counts, f.statuses.join(",")).toEqual({ needsYou: f.needsYou, inFlight: f.inFlight });
    }
  });
});

describe("needsYou", () => {
  it("a paused run needs the director — the engine's one 'human must act' run status", () => {
    // `paused` covers every waiting reason at run level: gate, halted stage,
    // budget park, director pause (the stage detail says which).
    expect(needsYou({ status: "paused" })).toBe(true);
  });

  it("every other run status does not", () => {
    for (const status of ["running", "completed", "aborted", "failed"] as const) {
      expect(needsYou({ status }), status).toBe(false);
    }
  });
});

describe("isTransientHalt parity with the menu bar (Rust fleet_status)", () => {
  // Rate limit, overload, 5xx, network, the relaunch's "interrupted" stamp and
  // a Claude plan limit are transient; standing faults, a hook-deferred tool
  // halt (whatever its tail says), network words inside other words and bare
  // numbers in prose are not. Rust's `is_transient_halt` reads the same file.
  it("flags every transient case of the shared fixture", () => {
    for (const e of transientFixtures.transient) {
      expect(isTransientHalt(e), e).toBe(true);
    }
  });

  it("flags none of its standing cases", () => {
    for (const e of transientFixtures.notTransient) {
      expect(isTransientHalt(e), String(e)).toBe(false);
    }
  });

  it("covers the edges it exists for", () => {
    const all = [...transientFixtures.transient, ...transientFixtures.notTransient].map(String);
    expect(all.some((e) => e.startsWith("interrupted"))).toBe(true);
    expect(all.some((e) => e.includes("(terminal_reason: tool_deferred)"))).toBe(true);
    expect(all.some((e) => e.includes("(plan_limit)"))).toBe(true);
    expect(transientFixtures.notTransient).toContain(null);
  });
});

describe("settledCounts", () => {
  it("counts only completed settled runs as done; aborted and failed are ended (#845)", () => {
    const runs = [
      { id: "a", status: "completed" as RunStatus },
      { id: "b", status: "aborted" as RunStatus },
      { id: "c", status: "failed" as RunStatus },
      { id: "d", status: "completed" as RunStatus }, // not settled this session
    ];
    expect(settledCounts(runs, { a: 1, b: 2, c: 3 })).toEqual({ done: 1, ended: 2 });
  });
});

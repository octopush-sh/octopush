import { describe, it, expect } from "vitest";
import type { PlanSnapshot } from "./ipc";
import {
  ageLabel, hasReset, lineAge, oldestSeen, orderWindows, pctLabel, planLine, planTone, planWarning, resetLabel,
  runsClaudeCli, windowLabel, windowName, windowTone,
} from "./claudePlan";

const NOW = Date.parse("2026-11-01T14:00:00Z");
const inSecs = (s: number) => Math.floor(NOW / 1000) + s;

const win = (over: Partial<PlanSnapshot>): PlanSnapshot => ({
  kind: "five_hour",
  utilization: 0.62,
  resetsAt: inSecs(2 * 3600),
  status: "allowed",
  overageStatus: null,
  usingOverage: false,
  seenAt: new Date(NOW - 12 * 60_000).toISOString(),
  ...over,
});

describe("claudePlan", () => {
  it("names windows, keeping unknown kinds readable", () => {
    expect(windowLabel("five_hour")).toBe("5h");
    expect(windowLabel("seven_day")).toBe("week");
    expect(windowLabel("seven_day_opus")).toBe("week opus");
    expect(windowLabel("some_new_window")).toBe("some new window");
    expect(windowName("five_hour")).toBe("5-hour window");
    expect(windowName("seven_day_sonnet")).toBe("weekly Sonnet window");
  });

  it("orders known windows first, unknown after", () => {
    const ws = [win({ kind: "zz_new" }), win({ kind: "seven_day" }), win({ kind: "seven_day_opus" }), win({ kind: "five_hour" })];
    expect(orderWindows(ws).map((w) => w.kind)).toEqual(["five_hour", "seven_day", "seven_day_opus", "zz_new"]);
  });

  it("reads the tone: sage, amber at 80%, rouge when rejected", () => {
    expect(windowTone(win({ utilization: 0.79 }), NOW)).toBe("calm");
    expect(windowTone(win({ utilization: 0.8 }), NOW)).toBe("near");
    expect(windowTone(win({ utilization: null, status: "allowed_warning" }), NOW)).toBe("near");
    expect(windowTone(win({ utilization: 0.4, status: "rejected" }), NOW)).toBe("limited");
    expect(planTone([win({}), win({ kind: "seven_day", status: "rejected" })], NOW)).toBe("limited");
    expect(planTone([], NOW)).toBe("calm");
  });

  it("never carries a figure past its window's reset", () => {
    const old = win({ utilization: 0.97, status: "rejected", resetsAt: inSecs(-60) });
    expect(hasReset(old, NOW)).toBe(true);
    expect(windowTone(old, NOW)).toBe("calm");
    expect(planWarning([old], NOW)).toBeNull();
    expect(planLine([old], NOW)).toBe("Claude plan · 5h reset since");
  });

  it("builds the Companion line with the 5-hour reset and the week", () => {
    const line = planLine([win({ kind: "seven_day", utilization: 0.31, resetsAt: inSecs(5 * 86400) }), win({})], NOW);
    expect(line).toBe(`Claude plan · 5h 62% · resets ${resetLabel(inSecs(2 * 3600), NOW)} · week 31%`);
  });

  it("adds another window to the line only when it is the one near its limit", () => {
    const opus = win({ kind: "seven_day_opus", utilization: 0.9 });
    expect(planLine([win({}), opus], NOW)).toContain("week opus 90%");
    expect(planLine([win({}), win({ kind: "seven_day_opus", utilization: 0.2 })], NOW)).not.toContain("opus");
    // Only an unknown kind reported: it is still shown.
    expect(planLine([win({ kind: "mystery", utilization: null, status: "rejected" })], NOW)).toContain("mystery limit reached");
  });

  it("warns calmly near and at the limit, and stays quiet otherwise", () => {
    const reset = resetLabel(inSecs(2 * 3600), NOW);
    expect(planWarning([win({})], NOW)).toBeNull();
    expect(planWarning([win({ utilization: 0.94 })], NOW)).toBe(`Your Claude plan's 5-hour window is at 94% — it resets at ${reset}.`);
    expect(planWarning([win({ status: "rejected" })], NOW)).toBe(`Your Claude plan's 5-hour window is used up — it resets at ${reset}.`);
    expect(planWarning([win({ utilization: null, status: "allowed_warning", resetsAt: null })], NOW)).toBe(
      "Your Claude plan's 5-hour window is near its limit.",
    );
  });

  it("always states the snapshot's age", () => {
    expect(ageLabel(new Date(NOW - 10_000).toISOString(), NOW)).toBe("as of just now");
    expect(ageLabel(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe("as of 12 min ago");
    expect(ageLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("as of 3 h ago");
    expect(ageLabel(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe("as of 1 day ago");
    expect(ageLabel("garbage", NOW)).toBe("as of an unknown time");
    expect(oldestSeen([win({ seenAt: "2026-11-01T12:00:00Z" }), win({ seenAt: "2026-11-01T10:00:00Z" })])).toBe("2026-11-01T10:00:00Z");
    expect(oldestSeen([win({ seenAt: "2026-11-01T12:00:00Z" }), win({ seenAt: "garbage" })])).toBe("garbage");
    expect(oldestSeen([])).toBeNull();
  });

  it("ages the line by the oldest figure it shows", () => {
    // A threshold event refreshed only the 5-hour window; the weekly figure is days old.
    const fresh = win({ seenAt: new Date(NOW - 10_000).toISOString() });
    const staleWeek = win({ kind: "seven_day", utilization: 0.31, seenAt: new Date(NOW - 3 * 86_400_000).toISOString() });
    expect(lineAge([fresh, staleWeek], NOW)).toBe("as of 3 days ago");
    // A window the line does not show does not age it.
    const staleOpus = win({ kind: "seven_day_opus", utilization: 0.2, seenAt: new Date(NOW - 3 * 86_400_000).toISOString() });
    expect(lineAge([fresh, staleOpus], NOW)).toBe("as of just now");
    expect(lineAge([], NOW)).toBeNull();
  });

  it("formats percentages and far-off resets", () => {
    expect(pctLabel(null)).toBe("—");
    expect(pctLabel(0.315)).toBe("32%");
    expect(resetLabel(inSecs(3 * 86400), NOW)).toMatch(/\S+ \d{2}:\d{2}/);
  });

  it("knows which runs can report plan windows", () => {
    expect(runsClaudeCli([{ substrate: "api", agentModel: "claude-sonnet-4-5" }])).toBe(false);
    expect(runsClaudeCli([{ substrate: "cli", agentModel: "gpt-5-codex" }])).toBe(false);
    expect(runsClaudeCli([{ substrate: "cli", agentModel: "claude-sonnet-4-5" }])).toBe(true);
  });
});

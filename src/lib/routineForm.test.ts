import { describe, it, expect } from "vitest";
import {
  scheduleSummary,
  untilLabel,
  draftFromRoutine,
  draftToInput,
  recurringSpecOf,
  to12h,
  type RoutineDraft,
} from "./routineForm";
import type { Routine } from "./ipc";

const baseDraft: RoutineDraft = {
  name: "Nightly",
  projectId: "p1",
  pipelineId: "pl1",
  task: "sweep deps",
  budgetUsd: "",
  scheduleKind: "daily",
  intervalValue: "6",
  intervalUnit: "hours",
  dailyTime: "09:00",
  recurDayMode: "weekly",
  recurDays: [1, 3, 5],
  recurDate: "",
  recurTimeMode: "once",
  recurAt: "09:00",
  recurStart: "09:00",
  recurStepMin: "60",
  recurEnd: "15:00",
  workspaceMode: "fixed",
  fixedWorkspaceId: "w1",
  baseBranch: "",
  branchPrefix: "routine",
  fireCondition: "",
};

describe("scheduleSummary", () => {
  it("summarizes daily and interval schedules", () => {
    expect(scheduleSummary("daily", "09:00")).toBe("Daily at 09:00");
    expect(scheduleSummary("interval", "3600")).toBe("Every 1 hour");
    expect(scheduleSummary("interval", "21600")).toBe("Every 6 hours");
    expect(scheduleSummary("interval", "300")).toBe("Every 5 minutes");
    expect(scheduleSummary("interval", "60")).toBe("Every 1 minute");
    expect(scheduleSummary("interval", "junk")).toBe("—");
  });
});

describe("untilLabel", () => {
  const now = Date.parse("2026-07-13T12:00:00Z");
  it("renders coarse relative times", () => {
    expect(untilLabel(null, now)).toBe("—");
    expect(untilLabel("2026-07-13T11:00:00Z", now)).toBe("due now"); // past
    expect(untilLabel("2026-07-13T12:30:00Z", now)).toBe("in 30 min");
    expect(untilLabel("2026-07-13T15:00:00Z", now)).toBe("in 3h");
    expect(untilLabel("2026-07-16T12:00:00Z", now)).toBe("in 3 days");
    expect(untilLabel("not-a-date", now)).toBe("—");
  });
});

describe("draftToInput validation", () => {
  it("requires name, project, pipeline, and a fixed workspace", () => {
    expect(draftToInput({ ...baseDraft, name: " " })).toBe("Give the routine a name.");
    expect(draftToInput({ ...baseDraft, projectId: "" })).toBe("Choose a project.");
    expect(draftToInput({ ...baseDraft, pipelineId: "" })).toBe("Choose a pipeline.");
    expect(draftToInput({ ...baseDraft, fixedWorkspaceId: "" })).toContain("Choose a workspace");
  });

  it("converts interval units to seconds and enforces the minute floor", () => {
    const asMinutes = draftToInput({ ...baseDraft, scheduleKind: "interval", intervalValue: "90", intervalUnit: "minutes" });
    expect(typeof asMinutes === "object" && asMinutes.scheduleSpec).toBe("5400");
    const asHours = draftToInput({ ...baseDraft, scheduleKind: "interval", intervalValue: "6", intervalUnit: "hours" });
    expect(typeof asHours === "object" && asHours.scheduleSpec).toBe("21600");
    expect(draftToInput({ ...baseDraft, scheduleKind: "interval", intervalValue: "0" })).toBe("Enter a positive interval.");
    expect(draftToInput({ ...baseDraft, scheduleKind: "interval", intervalValue: "0.5", intervalUnit: "minutes" })).toContain("at least a minute");
  });

  it("validates the daily HH:MM shape with 24-hour bounds", () => {
    expect(draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "9am" })).toContain("HH:MM");
    expect(draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "25:00" })).toContain("HH:MM");
    expect(draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "12:70" })).toContain("HH:MM");
    const ok = draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "07:30" });
    expect(typeof ok === "object" && ok.scheduleSpec).toBe("07:30");
  });

  it("forbids a fresh workspace on a more-than-once-a-day schedule (phase-1 rule)", () => {
    expect(
      draftToInput({ ...baseDraft, workspaceMode: "fresh", scheduleKind: "interval", fixedWorkspaceId: "" }),
    ).toContain("at most once a day");
    // fresh + recurring window is also rejected (fires many times a day)…
    expect(
      draftToInput({ ...baseDraft, workspaceMode: "fresh", scheduleKind: "recurring", recurTimeMode: "window", fixedWorkspaceId: "" }),
    ).toContain("at most once a day");
    // …but fresh + daily and fresh + recurring(once) are allowed.
    expect(typeof draftToInput({ ...baseDraft, workspaceMode: "fresh", scheduleKind: "daily", fixedWorkspaceId: "" })).toBe("object");
    expect(
      typeof draftToInput({ ...baseDraft, workspaceMode: "fresh", scheduleKind: "recurring", recurTimeMode: "once", fixedWorkspaceId: "" }),
    ).toBe("object");
  });

  it("drops the fixed workspace and keeps branch fields in fresh mode", () => {
    const fresh = draftToInput({ ...baseDraft, workspaceMode: "fresh", baseBranch: "main", branchPrefix: "nightly" });
    expect(typeof fresh === "object" && fresh.fixedWorkspaceId).toBeNull();
    expect(typeof fresh === "object" && fresh.baseBranch).toBe("main");
    expect(typeof fresh === "object" && fresh.branchPrefix).toBe("nightly");
  });

  it("parses an optional budget and rejects a negative one", () => {
    const withBudget = draftToInput({ ...baseDraft, budgetUsd: "2.50" });
    expect(typeof withBudget === "object" && withBudget.budgetUsd).toBe(2.5);
    expect(draftToInput({ ...baseDraft, budgetUsd: "-1" })).toContain("positive");
    const noBudget = draftToInput({ ...baseDraft, budgetUsd: "  " });
    expect(typeof noBudget === "object" && noBudget.budgetUsd).toBeNull();
  });

  it("trims the fire condition and omits an empty one", () => {
    const withCond = draftToInput({ ...baseDraft, fireCondition: "  gh pr view | grep -q .  " });
    expect(typeof withCond === "object" && withCond.fireCondition).toBe("gh pr view | grep -q .");
    // Empty / whitespace-only ⇒ undefined (omitted ⇒ always fire).
    const blank = draftToInput({ ...baseDraft, fireCondition: "   " });
    expect(typeof blank === "object" && blank.fireCondition).toBeUndefined();
    const none = draftToInput({ ...baseDraft, fireCondition: "" });
    expect(typeof none === "object" && none.fireCondition).toBeUndefined();
  });
});

describe("recurring schedules (Days × Times)", () => {
  it("summarizes the three canonical cases in plain English", () => {
    const mwf = `{"days":{"kind":"weekly","set":[1,3,5]},"time":{"kind":"once","at":"09:00"}}`;
    expect(scheduleSummary("recurring", mwf)).toBe("Mon, Wed & Fri at 9:00 AM");
    const win = `{"days":{"kind":"weekly","set":[1,2,3,4,5,6,7]},"time":{"kind":"window","start":"09:00","everyMinutes":60,"end":"15:00"}}`;
    expect(scheduleSummary("recurring", win)).toBe("Every hour, 9:00 AM–3:00 PM · every day");
    const wk = `{"days":{"kind":"weekly","set":[1,2,3,4,5]},"time":{"kind":"once","at":"09:00"}}`;
    expect(scheduleSummary("recurring", wk)).toBe("Weekdays at 9:00 AM");
    const date = `{"days":{"kind":"date","date":"2026-08-15"},"time":{"kind":"once","at":"09:00"}}`;
    expect(scheduleSummary("recurring", date)).toBe("Once on Aug 15, 2026 at 9:00 AM");
    expect(scheduleSummary("recurring", "not json")).toBe("—");
  });

  it("says 'On <date>' not 'Once' for a window on a specific date", () => {
    const dateWin = `{"days":{"kind":"date","date":"2026-08-15"},"time":{"kind":"window","start":"09:00","everyMinutes":30,"end":"11:00"}}`;
    const s = scheduleSummary("recurring", dateWin);
    expect(s).toBe("On Aug 15, 2026 — every 30 minutes, 9:00 AM–11:00 AM");
    expect(s.startsWith("Once")).toBe(false);
  });

  it("formats 12-hour times at the edges", () => {
    expect(to12h("00:00")).toBe("12:00 AM");
    expect(to12h("12:00")).toBe("12:00 PM");
    expect(to12h("23:59")).toBe("11:59 PM");
    expect(to12h("13:05")).toBe("1:05 PM");
  });

  it("recurringSpecOf returns null for an invalid draft, a spec otherwise", () => {
    expect(recurringSpecOf({ ...baseDraft, scheduleKind: "recurring", recurDays: [] })).toBeNull();
    const spec = recurringSpecOf({ ...baseDraft, scheduleKind: "recurring", recurDays: [1, 3, 5] });
    expect(spec && JSON.parse(spec).days).toEqual({ kind: "weekly", set: [1, 3, 5] });
  });

  it("round-trips a weekly-window routine losslessly", () => {
    const spec = `{"days":{"kind":"weekly","set":[2,4]},"time":{"kind":"window","start":"08:00","everyMinutes":120,"end":"16:00"}}`;
    const routine: Routine = {
      id: "r3", name: "W", projectId: "p1", pipelineId: "pl1", task: "t",
      referenceModel: null, stageOverrides: null, budgetUsd: null, scheduleKind: "recurring",
      scheduleSpec: spec, workspaceMode: "fixed", fixedWorkspaceId: "w1",
      baseBranch: null, branchPrefix: null, enabled: true, lastFiredAt: null,
      nextDueAt: null, lastRunId: null, createdAt: "t",
    };
    const d = draftFromRoutine(routine, "p0");
    expect(d.recurDays).toEqual([2, 4]);
    expect(d.recurTimeMode).toBe("window");
    expect(d.recurStepMin).toBe("120");
    const back = draftToInput(d);
    expect(typeof back === "object" && back.scheduleSpec).toBe(spec);
  });

  it("serializes a weekly window draft into the wire spec", () => {
    const out = draftToInput({
      ...baseDraft,
      scheduleKind: "recurring",
      recurDayMode: "weekly",
      recurDays: [1, 3, 5],
      recurTimeMode: "window",
      recurStart: "09:00",
      recurStepMin: "60",
      recurEnd: "15:00",
    });
    expect(typeof out).toBe("object");
    if (typeof out === "object") {
      expect(JSON.parse(out.scheduleSpec)).toEqual({
        days: { kind: "weekly", set: [1, 3, 5] },
        time: { kind: "window", start: "09:00", everyMinutes: 60, end: "15:00" },
      });
    }
  });

  it("round-trips a stored recurring routine into editable fields and back", () => {
    const spec = `{"days":{"kind":"date","date":"2026-08-15"},"time":{"kind":"once","at":"09:30"}}`;
    const routine: Routine = {
      id: "r2", name: "One-shot", projectId: "p1", pipelineId: "pl1", task: "t",
      referenceModel: null, stageOverrides: null, budgetUsd: null, scheduleKind: "recurring",
      scheduleSpec: spec, workspaceMode: "fixed", fixedWorkspaceId: "w1",
      baseBranch: null, branchPrefix: null, enabled: true, lastFiredAt: null,
      nextDueAt: null, lastRunId: null, createdAt: "t",
    };
    const d = draftFromRoutine(routine, "p0");
    expect(d.recurDayMode).toBe("date");
    expect(d.recurDate).toBe("2026-08-15");
    expect(d.recurTimeMode).toBe("once");
    expect(d.recurAt).toBe("09:30");
    const back = draftToInput(d);
    expect(typeof back === "object" && back.scheduleSpec).toBe(spec);
  });

  it("rejects an empty day set and a sub-15-minute window", () => {
    expect(draftToInput({ ...baseDraft, scheduleKind: "recurring", recurDays: [] })).toContain("at least one day");
    expect(
      draftToInput({ ...baseDraft, scheduleKind: "recurring", recurTimeMode: "window", recurStepMin: "5" }),
    ).toContain("15 minutes");
    expect(
      draftToInput({ ...baseDraft, scheduleKind: "recurring", recurTimeMode: "window", recurStart: "15:00", recurEnd: "09:00" }),
    ).toContain("end");
  });
});

describe("draftFromRoutine round-trip", () => {
  const routine: Routine = {
    id: "r1", name: "Sweep", projectId: "p1", pipelineId: "pl1", task: "t",
    referenceModel: null, stageOverrides: null, budgetUsd: 3, scheduleKind: "interval",
    scheduleSpec: "21600", workspaceMode: "fresh", fixedWorkspaceId: null,
    baseBranch: "main", branchPrefix: "nightly", enabled: true, lastFiredAt: null,
    nextDueAt: null, lastRunId: null, createdAt: "t",
    fireCondition: "gh pr view | grep -q .", lastCheckedAt: "2026-07-15T09:00:00Z",
    lastOutcome: "condition not met",
  };
  it("recovers hours from a whole-hour interval and preserves fresh fields", () => {
    const d = draftFromRoutine(routine, "p0");
    expect(d.intervalValue).toBe("6");
    expect(d.intervalUnit).toBe("hours");
    expect(d.workspaceMode).toBe("fresh");
    expect(d.baseBranch).toBe("main");
    expect(d.budgetUsd).toBe("3");
  });
  it("round-trips the fire condition into the draft and back", () => {
    const d = draftFromRoutine(routine, "p0");
    expect(d.fireCondition).toBe("gh pr view | grep -q .");
    // Back to the wire (via a valid fixed+daily combo — the fresh fixture is
    // interval, which draftToInput rejects; the condition is what we assert).
    const back = draftToInput({ ...d, workspaceMode: "fixed", fixedWorkspaceId: "w1", scheduleKind: "daily" });
    expect(typeof back === "object" && back.fireCondition).toBe("gh pr view | grep -q .");
  });
  it("defaults the fire condition to empty for a new routine", () => {
    const d = draftFromRoutine(null, "p9");
    expect(d.projectId).toBe("p9");
    expect(d.scheduleKind).toBe("daily");
    expect(d.workspaceMode).toBe("fixed");
    expect(d.fireCondition).toBe("");
  });
});

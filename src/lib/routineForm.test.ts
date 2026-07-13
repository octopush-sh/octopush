import { describe, it, expect } from "vitest";
import {
  scheduleSummary,
  untilLabel,
  draftFromRoutine,
  draftToInput,
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
  workspaceMode: "fixed",
  fixedWorkspaceId: "w1",
  baseBranch: "",
  branchPrefix: "routine",
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

  it("validates the daily HH:MM shape", () => {
    expect(draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "9am" })).toBe("Daily time must be HH:MM.");
    const ok = draftToInput({ ...baseDraft, scheduleKind: "daily", dailyTime: "07:30" });
    expect(typeof ok === "object" && ok.scheduleSpec).toBe("07:30");
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
});

describe("draftFromRoutine round-trip", () => {
  const routine: Routine = {
    id: "r1", name: "Sweep", projectId: "p1", pipelineId: "pl1", task: "t",
    referenceModel: null, stageOverrides: null, budgetUsd: 3, scheduleKind: "interval",
    scheduleSpec: "21600", workspaceMode: "fresh", fixedWorkspaceId: null,
    baseBranch: "main", branchPrefix: "nightly", enabled: true, lastFiredAt: null,
    nextDueAt: null, lastRunId: null, createdAt: "t",
  };
  it("recovers hours from a whole-hour interval and preserves fresh fields", () => {
    const d = draftFromRoutine(routine, "p0");
    expect(d.intervalValue).toBe("6");
    expect(d.intervalUnit).toBe("hours");
    expect(d.workspaceMode).toBe("fresh");
    expect(d.baseBranch).toBe("main");
    expect(d.budgetUsd).toBe("3");
  });
  it("defaults sensibly for a new routine", () => {
    const d = draftFromRoutine(null, "p9");
    expect(d.projectId).toBe("p9");
    expect(d.scheduleKind).toBe("daily");
    expect(d.workspaceMode).toBe("fixed");
  });
});

// Pure form logic for the Routines pane — schedule summaries, relative-time
// labels, and draft→wire validation. Extracted so it's unit-testable without
// the React tree.
import type { Routine, RoutineInput } from "./ipc";

export type ScheduleKind = "interval" | "daily" | "recurring";
export type DayMode = "weekly" | "date";
export type TimeMode = "once" | "window";

export interface RoutineDraft {
  name: string;
  projectId: string;
  pipelineId: string;
  task: string;
  budgetUsd: string;
  scheduleKind: ScheduleKind;
  intervalValue: string;
  intervalUnit: "minutes" | "hours";
  dailyTime: string;
  // Recurring (Days × Times) — active when scheduleKind === "recurring".
  recurDayMode: DayMode;
  recurDays: number[]; // ISO 1=Mon … 7=Sun
  recurDate: string; // YYYY-MM-DD
  recurTimeMode: TimeMode;
  recurAt: string; // HH:MM
  recurStart: string; // HH:MM
  recurStepMin: string; // minutes
  recurEnd: string; // HH:MM
  workspaceMode: "fixed" | "fresh";
  fixedWorkspaceId: string;
  baseBranch: string;
  branchPrefix: string;
  fireCondition: string;
}

// ── recurring spec (the JSON stored in schedule_spec) ───────────────────────

type RecurringSpec = {
  days: { kind: "weekly"; set: number[] } | { kind: "date"; date: string };
  time:
    | { kind: "once"; at: string }
    | { kind: "window"; start: string; everyMinutes: number; end: string };
};

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // ISO indexed
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseRecurring(spec: string): RecurringSpec | null {
  try {
    const s = JSON.parse(spec) as RecurringSpec;
    if (!s || !s.days || !s.time) return null;
    return s;
  } catch {
    return null;
  }
}

/** "9:00 AM" from "HH:MM". */
export function to12h(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  let h = Number(m[1]);
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

function stepLabel(min: number): string {
  if (min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? "hour" : `${h} hours`;
  }
  return `${min} minutes`;
}

function weeklyPhrase(set: number[]): string {
  const s = [...new Set(set)].sort((a, b) => a - b);
  if (s.length === 7) return "every day";
  if (s.length === 5 && [1, 2, 3, 4, 5].every((d) => s.includes(d))) return "weekdays";
  if (s.length === 2 && s.includes(6) && s.includes(7)) return "weekends";
  const names = s.map((d) => DAY_NAMES[d]).filter(Boolean);
  if (names.length <= 1) return names[0] ?? "no days";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function fmtDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** Human summary of a schedule, e.g. "Every 6 hours" / "Daily at 09:00" /
 *  "Mon, Wed & Fri at 9:00 AM" / "Every hour, 9:00 AM–3:00 PM · weekdays". */
export function scheduleSummary(kind: string, spec: string): string {
  if (kind === "daily") return `Daily at ${spec}`;
  if (kind === "recurring") {
    const s = parseRecurring(spec);
    if (!s) return "—";
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    if (s.days.kind === "date") {
      const base = `Once on ${fmtDate(s.days.date)}`;
      return s.time.kind === "once"
        ? `${base} at ${to12h(s.time.at)}`
        : `${base} — every ${stepLabel(s.time.everyMinutes)}, ${to12h(s.time.start)}–${to12h(s.time.end)}`;
    }
    const dp = weeklyPhrase(s.days.set);
    if (s.time.kind === "once") return `${cap(dp)} at ${to12h(s.time.at)}`;
    return `Every ${stepLabel(s.time.everyMinutes)}, ${to12h(s.time.start)}–${to12h(s.time.end)} · ${dp}`;
  }
  const secs = Number(spec);
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  if (secs % 3600 === 0) {
    const h = secs / 3600;
    return `Every ${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.round(secs / 60);
  return `Every ${m} minute${m === 1 ? "" : "s"}`;
}

/** Coarse relative time until a UTC instant, from `now` (ms). */
export function untilLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function draftFromRoutine(r: Routine | null, defaultProject: string): RoutineDraft {
  const base: RoutineDraft = {
    name: "",
    projectId: defaultProject,
    pipelineId: "",
    task: "",
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
    fixedWorkspaceId: "",
    baseBranch: "",
    branchPrefix: "routine",
    fireCondition: "",
  };
  if (!r) return base;

  const secs = Number(r.scheduleSpec);
  const asHours = r.scheduleKind === "interval" && Number.isFinite(secs) && secs % 3600 === 0;
  const d: RoutineDraft = {
    ...base,
    name: r.name,
    projectId: r.projectId,
    pipelineId: r.pipelineId,
    task: r.task,
    budgetUsd: r.budgetUsd == null ? "" : String(r.budgetUsd),
    scheduleKind: r.scheduleKind,
    intervalValue: r.scheduleKind === "interval" ? String(asHours ? secs / 3600 : Math.round(secs / 60)) : "6",
    intervalUnit: asHours ? "hours" : "minutes",
    dailyTime: r.scheduleKind === "daily" ? r.scheduleSpec : "09:00",
    workspaceMode: r.workspaceMode,
    fixedWorkspaceId: r.fixedWorkspaceId ?? "",
    baseBranch: r.baseBranch ?? "",
    branchPrefix: r.branchPrefix ?? "routine",
    fireCondition: r.fireCondition ?? "",
  };
  // Unpack a stored recurring spec into the editable fields.
  if (r.scheduleKind === "recurring") {
    const s = parseRecurring(r.scheduleSpec);
    if (s) {
      if (s.days.kind === "weekly") {
        d.recurDayMode = "weekly";
        d.recurDays = s.days.set;
      } else {
        d.recurDayMode = "date";
        d.recurDate = s.days.date;
      }
      if (s.time.kind === "once") {
        d.recurTimeMode = "once";
        d.recurAt = s.time.at;
      } else {
        d.recurTimeMode = "window";
        d.recurStart = s.time.start;
        d.recurStepMin = String(s.time.everyMinutes);
        d.recurEnd = s.time.end;
      }
    }
  }
  return d;
}

/** Validate a "HH:MM" with 24-hour bounds (mirrors the backend). */
function validHHMM(spec: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return false;
  return Number(m[1]) < 24 && Number(m[2]) < 60;
}
function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Build the recurring `schedule_spec` JSON, or an error string. */
function recurringSpec(d: RoutineDraft): string | { error: string } {
  let days: RecurringSpec["days"];
  if (d.recurDayMode === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.recurDate)) return { error: "Pick a date." };
    days = { kind: "date", date: d.recurDate };
  } else {
    if (d.recurDays.length === 0) return { error: "Choose at least one day." };
    days = { kind: "weekly", set: [...new Set(d.recurDays)].sort((a, b) => a - b) };
  }
  let time: RecurringSpec["time"];
  if (d.recurTimeMode === "window") {
    if (!validHHMM(d.recurStart) || !validHHMM(d.recurEnd)) return { error: "Window times must be HH:MM." };
    const step = Number(d.recurStepMin);
    if (!Number.isFinite(step) || step < 15) return { error: "A window must step at least 15 minutes." };
    if (minutesOf(d.recurEnd) < minutesOf(d.recurStart))
      return { error: "The window's end must be at or after its start." };
    time = { kind: "window", start: d.recurStart.trim(), everyMinutes: Math.round(step), end: d.recurEnd.trim() };
  } else {
    if (!validHHMM(d.recurAt)) return { error: "Time must be HH:MM (24-hour)." };
    time = { kind: "once", at: d.recurAt.trim() };
  }
  return JSON.stringify({ days, time });
}

/** The recurring `schedule_spec` JSON for a draft if its schedule is valid, else
 *  null — used by the editor to drive the live summary + "next runs" preview
 *  without requiring the whole draft (name/project/…) to be complete. */
export function recurringSpecOf(d: RoutineDraft): string | null {
  const spec = recurringSpec(d);
  return typeof spec === "string" ? spec : null;
}

/** Build the wire input, or an error string if the draft is incomplete. */
export function draftToInput(d: RoutineDraft): RoutineInput | string {
  if (!d.name.trim()) return "Give the routine a name.";
  if (!d.projectId) return "Choose a project.";
  if (!d.pipelineId) return "Choose a pipeline.";
  if (d.workspaceMode === "fixed" && !d.fixedWorkspaceId)
    return "Choose a workspace, or switch to a fresh one each run.";
  // Phase-1 rule (mirrors the backend): a fresh worktree per run needs at most a
  // once-a-day cadence — there's no automatic cleanup yet. So fresh allows Daily,
  // or a Custom schedule with a single time; never Interval or a Window.
  const freshAllowed =
    d.scheduleKind === "daily" || (d.scheduleKind === "recurring" && d.recurTimeMode === "once");
  if (d.workspaceMode === "fresh" && !freshAllowed)
    return "A fresh-workspace routine fires at most once a day — use Daily, or a Custom schedule with a single time.";

  let scheduleSpec: string;
  if (d.scheduleKind === "interval") {
    const n = Number(d.intervalValue);
    if (!Number.isFinite(n) || n <= 0) return "Enter a positive interval.";
    const secs = d.intervalUnit === "hours" ? n * 3600 : n * 60;
    if (secs < 60) return "The interval must be at least a minute.";
    scheduleSpec = String(Math.round(secs));
  } else if (d.scheduleKind === "recurring") {
    const spec = recurringSpec(d);
    if (typeof spec !== "string") return spec.error;
    scheduleSpec = spec;
  } else {
    if (!validHHMM(d.dailyTime)) return "Daily time must be HH:MM (24-hour).";
    scheduleSpec = d.dailyTime.trim();
  }

  const budget = d.budgetUsd.trim() === "" ? null : Number(d.budgetUsd);
  if (budget != null && (!Number.isFinite(budget) || budget < 0)) return "Budget must be zero or a positive number.";

  return {
    name: d.name.trim(),
    projectId: d.projectId,
    pipelineId: d.pipelineId,
    task: d.task.trim(),
    budgetUsd: budget,
    scheduleKind: d.scheduleKind,
    scheduleSpec,
    workspaceMode: d.workspaceMode,
    fixedWorkspaceId: d.workspaceMode === "fixed" ? d.fixedWorkspaceId : null,
    baseBranch: d.workspaceMode === "fresh" ? d.baseBranch.trim() || null : null,
    branchPrefix: d.workspaceMode === "fresh" ? d.branchPrefix.trim() || null : null,
    // Optional pre-fire gate — trim, empty → undefined (omitted ⇒ always fire).
    fireCondition: d.fireCondition.trim() || undefined,
  };
}

// Pure form logic for the Routines pane — schedule summaries, relative-time
// labels, and draft→wire validation. Extracted so it's unit-testable without
// the React tree.
import type { Routine, RoutineInput } from "./ipc";

export interface RoutineDraft {
  name: string;
  projectId: string;
  pipelineId: string;
  task: string;
  budgetUsd: string;
  scheduleKind: "interval" | "daily";
  intervalValue: string;
  intervalUnit: "minutes" | "hours";
  dailyTime: string;
  workspaceMode: "fixed" | "fresh";
  fixedWorkspaceId: string;
  baseBranch: string;
  branchPrefix: string;
}

/** Human summary of a schedule, e.g. "Every 6 hours" / "Daily at 09:00". */
export function scheduleSummary(kind: string, spec: string): string {
  if (kind === "daily") return `Daily at ${spec}`;
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
  if (!r) {
    return {
      name: "",
      projectId: defaultProject,
      pipelineId: "",
      task: "",
      budgetUsd: "",
      scheduleKind: "daily",
      intervalValue: "6",
      intervalUnit: "hours",
      dailyTime: "09:00",
      workspaceMode: "fixed",
      fixedWorkspaceId: "",
      baseBranch: "",
      branchPrefix: "routine",
    };
  }
  const secs = Number(r.scheduleSpec);
  const asHours = r.scheduleKind === "interval" && Number.isFinite(secs) && secs % 3600 === 0;
  return {
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
  };
}

/** Build the wire input, or an error string if the draft is incomplete. */
export function draftToInput(d: RoutineDraft): RoutineInput | string {
  if (!d.name.trim()) return "Give the routine a name.";
  if (!d.projectId) return "Choose a project.";
  if (!d.pipelineId) return "Choose a pipeline.";
  if (d.workspaceMode === "fixed" && !d.fixedWorkspaceId)
    return "Choose a workspace, or switch to a fresh one each run.";

  let scheduleSpec: string;
  if (d.scheduleKind === "interval") {
    const n = Number(d.intervalValue);
    if (!Number.isFinite(n) || n <= 0) return "Enter a positive interval.";
    const secs = d.intervalUnit === "hours" ? n * 3600 : n * 60;
    if (secs < 60) return "The interval must be at least a minute.";
    scheduleSpec = String(Math.round(secs));
  } else {
    if (!/^\d{1,2}:\d{2}$/.test(d.dailyTime.trim())) return "Daily time must be HH:MM.";
    scheduleSpec = d.dailyTime.trim();
  }

  const budget = d.budgetUsd.trim() === "" ? null : Number(d.budgetUsd);
  if (budget != null && (!Number.isFinite(budget) || budget < 0)) return "Budget must be a positive number.";

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
  };
}

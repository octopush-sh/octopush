// A `logbook_summary` fixture built from a scenario's own runs and chats, so
// the Logbook Room (and any other `logbook_summary` reader) shows the same
// ledger as the Direct companion and Talk. Mirrors the backend rollup in
// `src-tauri/src/db.rs` (`logbook_summary`): one row per mission in scope, with
// runs/messages counted and spend/savings summed inside the `[from, to]` window,
// and worked time as the union of activity spans.
import type { CommandArgs } from "./types";
import type { Run } from "../../../src/lib/ipc";
import type { ChatMessage, ChatThread, LogbookMissionRow, LogbookSurfaceSecs, Mission, Workspace } from "../../../src/lib/types";
import { NOW } from "./shared";

/** One mission and the work stamped with its id. */
export interface MissionLedger {
  mission: Mission;
  runs: Run[];
  threads: ChatThread[];
  /** Messages of `threads`. */
  messages: ChatMessage[];
}

/** The mission a workspace's work belongs to. */
export function missionFor(ws: Workspace, createdAt: string): Mission {
  return {
    id: `mission-${ws.id}`,
    workspaceId: ws.id,
    projectId: ws.projectId,
    intent: "build",
    title: ws.task || ws.name,
    status: "active",
    linkedIssueKey: ws.linkedIssueKey,
    gitIsolation: "worktree",
    execIsolation: "none",
    payload: "{}",
    createdAt,
    updatedAt: NOW,
    archivedAt: null,
  };
}

const ms = (iso: string) => Date.parse(iso);

/** Union length, in seconds, of `[start, end]` intervals (ms). */
function unionSecs(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of sorted) {
    if (cur && a <= cur[1]) cur = [cur[0], Math.max(cur[1], b)];
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / 1000);
}

/**
 * The `logbook_summary` handler for a set of missions.
 *
 * Fixture timestamps are anchored to `NOW`, but the app asks for a window
 * relative to its own clock (the WebKit audit can't fix it). So ages are kept,
 * not dates: an item `d` before `NOW` counts as `d` before `to`. The fixture
 * reads the same on any day.
 */
export function logbookSummary(ledgers: MissionLedger[]) {
  return (a: CommandArgs): LogbookMissionRow[] => {
    const scopeType = String(a.scopeType ?? "");
    const scopeId = a.scopeId == null ? null : String(a.scopeId);
    const to = a.to ? ms(String(a.to)) : ms(NOW);
    const from = a.from ? ms(String(a.from)) : Number.NEGATIVE_INFINITY;
    const shift = to - ms(NOW);
    const at = (iso: string) => ms(iso) + shift;
    const inWindow = (iso: string) => at(iso) >= from && at(iso) <= to;
    // A span `[start, end]` clamped to the window, as the backend does.
    const clamp = (start: string, end: string): [number, number] => [Math.max(at(start), from), Math.min(at(end), to)];

    const inScope = ledgers.filter(({ mission: m }) => {
      if (scopeType === "mission") return m.id === scopeId;
      if (scopeType === "project") return m.projectId === scopeId;
      if (scopeType === "global") return m.status !== "archived";
      return false;
    });

    return inScope.map(({ mission, runs, threads, messages }) => {
      const r = runs.filter((x) => inWindow(x.createdAt));
      const msgs = messages.filter((x) => inWindow(x.createdAt));
      const direct = runs.map((x) => clamp(x.createdAt, x.finishedAt ?? NOW));
      const talk = threads.map((x) => clamp(x.createdAt, x.updatedAt));
      const perSurface: LogbookSurfaceSecs[] = (
        [["direct", direct], ["talk", talk]] as const
      )
        .map(([surface, spans]) => ({ surface, secs: unionSecs([...spans]) }))
        .filter((s) => s.secs > 0);
      return {
        missionId: mission.id,
        title: mission.title,
        intent: mission.intent,
        status: mission.status,
        hoursSecs: unionSecs([...direct, ...talk]),
        costUsd: r.reduce((s, x) => s + x.costUsd, 0) + msgs.reduce((s, x) => s + (x.costUsd ?? 0), 0),
        savingsUsd: r.reduce((s, x) => s + Math.max(0, x.baselineUsd - x.costUsd), 0),
        runsCount: r.length,
        messagesCount: msgs.length,
        perSurface,
      };
    });
  };
}

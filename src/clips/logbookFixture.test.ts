import { describe, expect, it } from "vitest";
import { createDispatcher } from "./dispatcher";
import { SCENARIOS } from "../../scripts/clips/scenarios";
import { NOW } from "../../scripts/clips/scenarios/shared";
import { aggregateSavings } from "../lib/runStatus";
import { periodRange, type PeriodKey } from "../lib/logbook";
import type { Run } from "../lib/ipc";
import type { ChatThread, LogbookMissionRow, ProjectInfo, Workspace } from "../lib/types";

// The Logbook must read the same ledger as the Direct companion and Talk in
// the scenarios the visual audit renders (#673): an empty Logbook next to 18
// runs reads as an app bug.
function ledger(name: string) {
  const { handle } = createDispatcher(SCENARIOS[name]);
  const project = handle("open_project") as ProjectInfo;
  const active = JSON.parse(SCENARIOS[name].localStorage!.lastActiveWorkspacePerProject)[project.id] as string;
  const ws = (handle("list_workspaces") as Workspace[]).find((w) => w.id === active)!;
  const runs = handle("list_runs", { workspaceId: ws.id }) as Run[];
  const threads = handle("list_chat_threads", { workspaceId: ws.id }) as ChatThread[];
  const messages = threads.flatMap((t) => handle("list_chat_messages", { threadId: t.id }) as unknown[]);
  const summary = (scopeType: string, scopeId: string | null, period: PeriodKey, now: Date) => {
    const { from, to } = periodRange(period, now);
    return handle("logbook_summary", { scopeType, scopeId, from, to }) as LogbookMissionRow[];
  };
  return { project, runs, threads, messages, summary };
}

describe.each(["default", "stress"])("%s scenario Logbook", (name) => {
  const { project, runs, messages, summary } = ledger(name);

  it("rolls up the same runs, savings and messages the rest of the app shows", () => {
    const rows = summary("project", project.id, "30d", new Date(NOW));
    expect(rows.length).toBeGreaterThan(0);
    const runsCount = rows.reduce((a, r) => a + r.runsCount, 0);
    const saved = rows.reduce((a, r) => a + r.savingsUsd, 0);
    expect(runsCount).toBe(runs.length);
    expect(saved).toBeCloseTo(aggregateSavings(runs).saved, 2);
    expect(rows.reduce((a, r) => a + r.messagesCount, 0)).toBe(messages.length);
    expect(rows.every((r) => r.hoursSecs > 0)).toBe(true);
  });

  it("reads the same whatever the real clock says (WebKit can't fix it)", () => {
    const later = new Date(Date.parse(NOW) + 90 * 24 * 60 * 60 * 1000);
    expect(summary("project", project.id, "30d", later)).toEqual(summary("project", project.id, "30d", new Date(NOW)));
  });

  it("scopes by project, globally and per mission", () => {
    const [row] = summary("project", project.id, "all", new Date(NOW));
    expect(summary("project", "someone-else", "all", new Date(NOW))).toEqual([]);
    expect(summary("global", null, "all", new Date(NOW))).toEqual([row]);
    expect(summary("mission", row.missionId, "all", new Date(NOW))).toEqual([row]);
  });
});

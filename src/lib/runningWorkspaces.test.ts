import { describe, it, expect } from "vitest";
import { hasActiveDirectRun } from "./runningWorkspaces";
import type { Run, RunStatus } from "./ipc";

function run(status: RunStatus): Run {
  return {
    id: "r", workspaceId: "w", pipelineId: "p", task: "", status,
    costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null,
    createdAt: "", finishedAt: null, budgetUsd: null,
  };
}

describe("hasActiveDirectRun", () => {
  it("is true only when a run is actively running", () => {
    expect(hasActiveDirectRun([run("running")])).toBe(true);
    expect(hasActiveDirectRun([run("completed"), run("running")])).toBe(true);
  });

  it("excludes paused — a checkpoint is attention, not processing", () => {
    expect(hasActiveDirectRun([run("paused")])).toBe(false);
  });

  it("is false for non-running statuses and empty/undefined", () => {
    expect(hasActiveDirectRun([run("draft")])).toBe(false);
    expect(hasActiveDirectRun([run("completed")])).toBe(false);
    expect(hasActiveDirectRun([run("aborted")])).toBe(false);
    expect(hasActiveDirectRun([run("failed")])).toBe(false);
    expect(hasActiveDirectRun([])).toBe(false);
    expect(hasActiveDirectRun(undefined)).toBe(false);
  });
});

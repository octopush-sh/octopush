/** decideNotification — the pure anti-noise contract of crew notifications. */
import { describe, it, expect } from "vitest";
import { decideNotification } from "./crewNotifications";
import type { Run } from "./ipc";

const run = (status: Run["status"], over: Partial<Run> = {}): Run => ({
  id: "r1", workspaceId: "w1", pipelineId: "p", task: "Add CSV export to the reports module",
  status, costUsd: 0.42, baselineUsd: 1, referenceModel: null, linkedIssueKey: null,
  createdAt: "t", finishedAt: null, budgetUsd: null, ...over,
});

describe("decideNotification", () => {
  it("running → paused: the crew needs you", () => {
    const n = decideNotification("running", run("paused"), "checkout-flow");
    expect(n?.title).toBe("The crew needs you");
    expect(n?.body).toContain("checkout-flow");
    expect(n?.body).toContain("Add CSV export");
  });

  it("running → completed: crew finished, with the cost", () => {
    const n = decideNotification("running", run("completed"), "checkout-flow");
    expect(n?.title).toBe("Crew finished");
    expect(n?.body).toContain("$0.42");
  });

  it("aborted is the director's own hand — silence", () => {
    expect(decideNotification("running", run("aborted"), "ws")).toBeNull();
  });

  it("first sight records but never notifies", () => {
    expect(decideNotification(undefined, run("paused"), "ws")).toBeNull();
  });

  it("same status re-observed is not news", () => {
    expect(decideNotification("paused", run("paused"), "ws")).toBeNull();
  });

  it("a draft becoming active is not news either", () => {
    expect(decideNotification("draft", run("running"), "ws")).toBeNull();
    expect(decideNotification("draft", run("completed"), "ws")).toBeNull();
  });

  it("long tasks are trimmed; a missing workspace name degrades honestly", () => {
    const n = decideNotification("running", run("paused", { task: "x".repeat(200) }), null);
    expect(n?.body.length).toBeLessThan(120);
    expect(n?.body).toContain("a workspace");
    expect(n?.body).toContain("…");
  });
});

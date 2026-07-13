/** The pure notification decisions — needs-you (checkpoint) + finished. */
import { describe, it, expect } from "vitest";
import {
  decideCompletionNotification,
  decideCheckpointNotification,
} from "./crewNotifications";
import type { Run } from "./ipc";

const run = (status: Run["status"], over: Partial<Run> = {}): Run => ({
  id: "r1", workspaceId: "w1", pipelineId: "p", task: "Add CSV export to the reports module",
  status, costUsd: 0.42, baselineUsd: 1, referenceModel: null, linkedIssueKey: null,
  createdAt: "t", finishedAt: null, budgetUsd: null, detached: false, ...over,
});

describe("decideCheckpointNotification (needs you)", () => {
  it("fires for a decision park, with workspace and task", () => {
    const n = decideCheckpointNotification("decision", run("paused"), "checkout-flow");
    expect(n?.title).toBe("The crew needs you");
    expect(n?.body).toContain("checkout-flow");
    expect(n?.body).toContain("Add CSV export");
  });

  it("the director's own requested pause is NOT news", () => {
    expect(decideCheckpointNotification("director", run("paused"), "ws")).toBeNull();
  });

  it("a legacy event without a reason still pings (fail toward the gate)", () => {
    expect(decideCheckpointNotification(undefined, run("paused"), "ws")).not.toBeNull();
  });

  it("stays silent when the run row isn't hydrated yet — silent beats wrong", () => {
    expect(decideCheckpointNotification("decision", undefined, null)).toBeNull();
  });
});

describe("decideCompletionNotification (finished)", () => {
  it("active → completed: crew finished with the cost", () => {
    const n = decideCompletionNotification("running", run("completed"), "checkout-flow");
    expect(n?.title).toBe("Crew finished");
    expect(n?.body).toContain("$0.42");
  });

  it("aborted is the director's own hand — silence", () => {
    expect(decideCompletionNotification("running", run("aborted"), "ws")).toBeNull();
  });

  it("a paused transition is NOT completion news (checkpoints own needs-you)", () => {
    expect(decideCompletionNotification("running", run("paused"), "ws")).toBeNull();
  });

  it("first sight records but never notifies; same status is not news", () => {
    expect(decideCompletionNotification(undefined, run("completed"), "ws")).toBeNull();
    expect(decideCompletionNotification("completed", run("completed"), "ws")).toBeNull();
  });

  it("drafts becoming active are not news", () => {
    expect(decideCompletionNotification("draft", run("completed"), "ws")).toBeNull();
  });

  it("long tasks trim surrogate-safe; a missing workspace name degrades honestly", () => {
    const emojiTask = "x".repeat(69) + "🐙" + "y".repeat(50);
    const n = decideCompletionNotification("running", run("completed", { task: emojiTask }), null);
    expect(n?.body).toContain("a workspace");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(n!.body)).toBe(false);
  });
});

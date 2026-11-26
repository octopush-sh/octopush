import { describe, it, expect } from "vitest";
import type { Run, RunStage } from "./ipc";
import { prVerdict, runVerdict, waitingLine } from "./prerequisite";

const run = (status: Run["status"]) => ({ id: "r1", status }) as Run;
const stage = (status: RunStage["status"], checkpoint = false) => ({ status, checkpoint }) as RunStage;
const WAITING = { met: false, hold: null };

describe("runVerdict", () => {
  it("waits with no run or a draft, and is met once the run completed", () => {
    expect(runVerdict(null, [])).toEqual(WAITING);
    expect(runVerdict(run("draft"), [])).toEqual(WAITING);
    expect(runVerdict(run("completed"), [])).toEqual({ met: true });
  });

  it("is met once every gate of a run at work is done; with no gate, only on completion", () => {
    expect(runVerdict(run("running"), [stage("done", true), stage("running")])).toEqual({ met: true });
    expect(runVerdict(run("paused"), [stage("awaiting_checkpoint", true), stage("pending", true)])).toEqual(WAITING);
    expect(runVerdict(run("running"), [stage("done"), stage("running")])).toEqual(WAITING);
  });

  it("keeps waiting, and says why, on a halted, aborted or failed run", () => {
    expect(runVerdict(run("paused"), [stage("done", true), stage("failed")])).toEqual({ met: false, hold: "halted" });
    expect(runVerdict(run("aborted"), [])).toEqual({ met: false, hold: "aborted" });
    expect(runVerdict(run("failed"), [])).toEqual({ met: false, hold: "failed" });
  });
});

it("prVerdict is met only on a merged pull request", () => {
  const pr = (state: "open" | "merged" | "closed") => ({ number: 1, title: "", url: "", isDraft: false, state });
  expect(prVerdict(pr("merged"))).toEqual({ met: true });
  expect(prVerdict(pr("open")).met).toBe(false);
  expect(prVerdict(pr("closed")).met).toBe(false);
  expect(prVerdict(null).met).toBe(false);
});

it("waitingLine names the prerequisite, the condition and why a stopped run still waits", () => {
  expect(waitingLine("run_finished", "auth")).toBe("Starts after auth's run passes its last gate");
  expect(waitingLine("pr_merged", "auth")).toBe("Starts after auth's pull request merges");
  expect(waitingLine("run_finished", "auth", "halted")).toBe(
    "Starts after auth's run passes its last gate. That run halted, so this mission keeps waiting",
  );
  expect(waitingLine("run_finished", "a", "aborted")).toContain("That run was aborted");
  expect(waitingLine("pr_merged", "a", "failed")).toBe("Starts after a's pull request merges");
});

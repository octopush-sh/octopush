import { beforeEach, describe, expect, it, vi } from "vitest";
import { prefillFixChecks } from "./fixChecks";
import { ipc } from "./ipc";
import type { Pr } from "./types";
import { useRunsStore } from "../stores/runsStore";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return { ...actual, ipc: { ...actual.ipc, prFailedCheckLogs: vi.fn() } };
});

const logs = vi.mocked(ipc.prFailedCheckLogs);

const pr: Pr = {
  number: 42,
  title: "Add exports",
  url: "https://github.com/o/r/pull/42",
  isDraft: false,
  state: "open",
  checks: { state: "failing", failing: [{ name: "test", runId: 12 }, { name: "lint", runId: 12 }] },
};

beforeEach(() => {
  logs.mockReset();
  useRunsStore.setState({ launcherPrefill: null, selectedRunIdByWs: {} });
});

describe("prefillFixChecks", () => {
  it("reads the failed runs' logs and seeds this workspace's launcher with them", async () => {
    logs.mockResolvedValue("Error: expected 2, got 3");
    await prefillFixChecks(pr, "w1", "/repo/w1");
    expect(logs).toHaveBeenCalledWith("/repo/w1", [12]);
    const prefill = useRunsStore.getState().launcherPrefill!;
    expect(prefill.workspaceId).toBe("w1");
    expect(prefill.pipelineId).toBe("");
    expect(prefill.task).toContain("- test\n- lint");
    expect(prefill.task).toContain("```\nError: expected 2, got 3\n```");
    expect(useRunsStore.getState().selectedRunIdByWs.w1).toBeNull();
  });

  it("still opens the launcher, without a log section, when the logs can't be read", async () => {
    logs.mockRejectedValue(new Error("gh: not logged in"));
    await prefillFixChecks(pr, "w1", "/repo/w1");
    const prefill = useRunsStore.getState().launcherPrefill!;
    expect(prefill.task).toContain("- test\n- lint");
    expect(prefill.task).not.toContain("gh run view");
    expect(useRunsStore.getState().selectedRunIdByWs.w1).toBeNull();
  });

  it("skips the log read when no failing check has an Actions run, and still names them", async () => {
    const external: Pr = {
      ...pr,
      checks: { state: "failing", failing: [{ name: "ci/circle", runId: null }, { name: "buildkite", runId: null }] },
    };
    await prefillFixChecks(external, "w1", "/repo/w1");
    expect(logs).not.toHaveBeenCalled();
    const prefill = useRunsStore.getState().launcherPrefill!;
    expect(prefill.task).toContain("- ci/circle\n- buildkite");
    expect(prefill.task).not.toContain("gh run view");
  });
});

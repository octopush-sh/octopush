import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Run } from "./ipc";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    ipc: {
      genesisRenameCandidate: vi.fn(),
      aiComplete: vi.fn(),
      markGenesisRenamed: vi.fn(),
      updateProjectCustomization: vi.fn(),
    },
  };
});

const pushToastMock = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToastMock(t) }));
vi.mock("../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ current: null, loadRecent: vi.fn() }), setState: vi.fn() },
}));

import { ipc } from "./ipc";
import { maybeOffer } from "./genesisRename";

const m = {
  candidate: vi.mocked(ipc.genesisRenameCandidate),
  ai: vi.mocked(ipc.aiComplete),
  marked: vi.mocked(ipc.markGenesisRenamed),
  rename: vi.mocked(ipc.updateProjectCustomization),
};

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "completed",
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null,
  createdAt: "", finishedAt: null, budgetUsd: null, detached: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.marked.mockResolvedValue(undefined);
  m.rename.mockResolvedValue(undefined);
});

describe("genesis post-build rename", () => {
  it("offers a rename for a genesis project, marks it one-shot, and the action renames", async () => {
    m.candidate.mockResolvedValue({ projectId: "proj1", prompt: "a CLI to track daily tasks" });
    m.ai.mockResolvedValue({ text: "task-tracker", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    await maybeOffer(run());
    // One-shot: marked offered regardless of accept/dismiss.
    expect(m.marked).toHaveBeenCalledWith("proj1");
    const toast = pushToastMock.mock.calls[0][0];
    expect(toast.body).toContain("task-tracker");
    // The action performs the rename.
    toast.action.onClick();
    expect(m.rename).toHaveBeenCalledWith("proj1", "task-tracker", null);
  });

  it("does nothing for a non-genesis (or already-offered) project", async () => {
    m.candidate.mockResolvedValue(null);
    await maybeOffer(run());
    expect(m.ai).not.toHaveBeenCalled();
    expect(pushToastMock).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic slug when the naming call fails", async () => {
    m.candidate.mockResolvedValue({ projectId: "proj1", prompt: "Build me an iOS habit tracker app" });
    m.ai.mockRejectedValue(new Error("no key"));
    await maybeOffer(run());
    const toast = pushToastMock.mock.calls[0][0];
    // deriveProjectName("Build me an iOS habit tracker app") → "ios-habit-tracker"
    expect(toast.body).toContain("ios-habit-tracker");
  });
});

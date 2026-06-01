import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIpc = { getIssue: vi.fn() };
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useParentIssuesStore } = await import("./parentIssuesStore");

beforeEach(() => {
  vi.clearAllMocks();
  // Reset store between tests.
  useParentIssuesStore.setState({ parents: {}, loading: {} });
});

describe("parentIssuesStore", () => {
  it("loads a parent on first request and caches it", async () => {
    const issue = {
      key: "EPIC-1",
      summary: "Notifications",
      statusName: "In Progress",
      statusCategory: "inProgress" as const,
      issueType: "Epic",
      priority: null,
      url: "https://x/browse/EPIC-1",
      parentKey: null,
      subtask: false,
      hierarchyLevel: 0,
    };
    mockIpc.getIssue.mockResolvedValue(issue);

    await useParentIssuesStore.getState().loadParent("EPIC-1");
    expect(useParentIssuesStore.getState().parents["EPIC-1"]).toEqual(issue);
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(1);

    // Second call must hit cache — no extra ipc call.
    await useParentIssuesStore.getState().loadParent("EPIC-1");
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(1);
  });

  it("survives a getIssue failure without crashing", async () => {
    mockIpc.getIssue.mockRejectedValue(new Error("404"));
    await useParentIssuesStore.getState().loadParent("MISSING-1");
    expect(useParentIssuesStore.getState().parents["MISSING-1"]).toBeUndefined();
    // The failed load is not marked as in-flight after settling.
    expect(useParentIssuesStore.getState().loading["MISSING-1"]).toBeFalsy();
  });

  it("guards against concurrent loads for the same key", async () => {
    let resolveOne!: (v: unknown) => void;
    mockIpc.getIssue.mockImplementation(
      () => new Promise((res) => { resolveOne = res; }),
    );
    const p1 = useParentIssuesStore.getState().loadParent("E-1");
    const p2 = useParentIssuesStore.getState().loadParent("E-1");
    resolveOne({
      key: "E-1", summary: "x", statusName: "x", statusCategory: "todo",
      issueType: "Epic", priority: null, url: "u", parentKey: null,
      subtask: false, hierarchyLevel: 0,
    });
    await Promise.all([p1, p2]);
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(1);
  });
});

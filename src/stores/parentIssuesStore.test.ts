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

describe("loadAncestors", () => {
  it("loads parent only when depth === 1", async () => {
    const parent = {
      key: "STORY-1", summary: "story", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: "EPIC-1",
      subtask: false, hierarchyLevel: 0,
    };
    mockIpc.getIssue.mockResolvedValueOnce(parent);

    await useParentIssuesStore.getState().loadAncestors("STORY-1", 1);

    expect(useParentIssuesStore.getState().parents["STORY-1"]).toEqual(parent);
    expect(useParentIssuesStore.getState().parents["EPIC-1"]).toBeUndefined();
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(1);
  });

  it("loads parent + grandparent when depth === 2 and parent has parentKey", async () => {
    const parent = {
      key: "STORY-1", summary: "story", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: "EPIC-1",
      subtask: false, hierarchyLevel: 0,
    };
    const grandparent = {
      key: "EPIC-1", summary: "epic", statusName: "x", statusCategory: "inProgress" as const,
      issueType: "Epic", priority: null, url: "u", parentKey: null,
      subtask: false, hierarchyLevel: 1,
    };
    mockIpc.getIssue
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(grandparent);

    await useParentIssuesStore.getState().loadAncestors("STORY-1", 2);

    expect(useParentIssuesStore.getState().parents["STORY-1"]).toEqual(parent);
    expect(useParentIssuesStore.getState().parents["EPIC-1"]).toEqual(grandparent);
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(2);
  });

  it("stops at parent when parent has no parentKey (no further lookup)", async () => {
    const orphan = {
      key: "ORPHAN-1", summary: "x", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: null,
      subtask: false, hierarchyLevel: 0,
    };
    mockIpc.getIssue.mockResolvedValueOnce(orphan);

    await useParentIssuesStore.getState().loadAncestors("ORPHAN-1", 2);

    expect(useParentIssuesStore.getState().parents["ORPHAN-1"]).toEqual(orphan);
    expect(mockIpc.getIssue).toHaveBeenCalledTimes(1);
  });
});

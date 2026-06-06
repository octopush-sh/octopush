import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectInfo } from "../lib/types";

function proj(id: string): ProjectInfo {
  return { id, name: id.toUpperCase(), path: `/repo/${id}`, jiraProjectKey: null, pinned: false };
}

const mockIpc = {
  closeProject: vi.fn<(id: string) => Promise<void>>(),
  reopenProject: vi.fn<(id: string) => Promise<void>>(),
  listRecentProjects: vi.fn<() => Promise<ProjectInfo[]>>(),
  listClosedProjects: vi.fn<() => Promise<ProjectInfo[]>>(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useProjectStore } = await import("./projectStore");

function resetStore() {
  useProjectStore.setState({ current: null, recent: [], closed: [], loading: false, error: null });
  vi.clearAllMocks();
}

describe("projectStore — closeProject", () => {
  beforeEach(() => resetStore());

  it("reloads recent + closed and clears current when the active project is closed (C2)", async () => {
    const a = proj("a");
    useProjectStore.setState({ current: a, recent: [a], closed: [] });
    mockIpc.closeProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([a]);

    await useProjectStore.getState().closeProject("a");

    const s = useProjectStore.getState();
    expect(mockIpc.closeProject).toHaveBeenCalledWith("a");
    expect(s.recent).toEqual([]);
    expect(s.closed.map((p) => p.id)).toEqual(["a"]);
    expect(s.current).toBeNull();
  });

  it("leaves current intact when a different (non-active) project is closed", async () => {
    const a = proj("a");
    const b = proj("b");
    useProjectStore.setState({ current: a, recent: [a, b], closed: [] });
    mockIpc.closeProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([a]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([b]);

    await useProjectStore.getState().closeProject("b");

    expect(useProjectStore.getState().current?.id).toBe("a");
  });
});

describe("projectStore — reopenProject", () => {
  beforeEach(() => resetStore());

  it("reloads recent + closed after reopening", async () => {
    const a = proj("a");
    useProjectStore.setState({ current: null, recent: [], closed: [a] });
    mockIpc.reopenProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([a]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([]);

    await useProjectStore.getState().reopenProject("a");

    const s = useProjectStore.getState();
    expect(mockIpc.reopenProject).toHaveBeenCalledWith("a");
    expect(s.recent.map((p) => p.id)).toEqual(["a"]);
    expect(s.closed).toEqual([]);
  });
});

describe("projectStore — loadClosed", () => {
  beforeEach(() => resetStore());

  it("populates the closed list from ipc", async () => {
    const a = proj("a");
    mockIpc.listClosedProjects.mockResolvedValueOnce([a]);
    await useProjectStore.getState().loadClosed();
    expect(useProjectStore.getState().closed.map((p) => p.id)).toEqual(["a"]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workspace } from "./types";

const mockIpc = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  workspacesGitSummary: vi.fn(),
  mergedWorkspaces: vi.fn(),
  listGroups: vi.fn(),
}));
vi.mock("./ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ipc")>();
  return { ...original, ipc: { ...original.ipc, ...mockIpc } };
});
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../components/Toasts", () => ({ pushToast }));

import { archiveMergedMissions } from "./archiveMerged";
import { useWorkspaceStore } from "../stores/workspaceStore";

const ws = (id: string, name: string): Workspace =>
  ({ id, projectId: "p1", name, branch: `b-${id}`, worktreePath: `/wt/${id}`, status: "active" }) as Workspace;

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue([]);
  mockIpc.archiveWorkspace.mockResolvedValue(undefined);
  mockIpc.restoreWorkspace.mockResolvedValue(undefined);
  pushToast.mockReset();
  useWorkspaceStore.setState({ workspaces: [], workspacesByProjectId: { p1: [ws("a", "fix-a"), ws("b", "fix-b")] } });
});

describe("archiveMergedMissions", () => {
  it("archives each mission, keeping its branch, and offers Undo", async () => {
    const done = await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a"), ws("b", "fix-b")]);
    expect(done).toEqual(["a", "b"]);
    expect(mockIpc.archiveWorkspace).toHaveBeenCalledWith("a", "/repo", "b-a", "/wt/a");
    expect(mockIpc.archiveWorkspace).toHaveBeenCalledWith("b", "/repo", "b-b", "/wt/b");
    expect(useWorkspaceStore.getState().workspacesByProjectId.p1).toEqual([]);
    const toast = pushToast.mock.calls[0][0];
    expect(toast.title).toBe("Archived 2 merged missions");
    expect(toast.action.label).toBe("Undo");
  });

  it("Undo restores them and reloads the project", async () => {
    await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a")]);
    expect(pushToast.mock.calls[0][0].title).toBe('Archived "fix-a"');
    pushToast.mock.calls[0][0].action.onClick();
    await vi.waitFor(() => expect(mockIpc.listWorkspaces).toHaveBeenCalledWith("p1"));
    expect(mockIpc.restoreWorkspace).toHaveBeenCalledWith("a", "/repo", "b-a", "/wt/a");
  });

  it("says when one fails, and keeps the ones that worked", async () => {
    mockIpc.archiveWorkspace.mockRejectedValueOnce("locked");
    const done = await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a"), ws("b", "fix-b")]);
    expect(done).toEqual(["b"]);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Archive failed" }));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archived "fix-b"' }));
  });
});

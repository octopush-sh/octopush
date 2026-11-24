import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workspace } from "./types";

const mockIpc = vi.hoisted(() => ({
  archiveMergedWorkspaces: vi.fn(),
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

import { archiveMergedMissions, skippedBody } from "./archiveMerged";
import { useWorkspaceStore } from "../stores/workspaceStore";

const ws = (id: string, name: string): Workspace =>
  ({ id, projectId: "p1", name, branch: `b-${id}`, worktreePath: `/wt/${id}`, status: "active" }) as Workspace;

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue([]);
  mockIpc.archiveMergedWorkspaces.mockImplementation(async (_p: string, _path: string, ids: string[]) => ({
    archived: ids,
    skipped: [],
  }));
  mockIpc.restoreWorkspace.mockResolvedValue(undefined);
  pushToast.mockReset();
  useWorkspaceStore.setState({ workspaces: [], workspacesByProjectId: { p1: [ws("a", "fix-a"), ws("b", "fix-b")] } });
});

describe("archiveMergedMissions", () => {
  it("asks the backend to re-check and archive them, then offers Undo", async () => {
    const done = await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a"), ws("b", "fix-b")], ["b"]);
    expect(done).toEqual(["a", "b"]);
    expect(mockIpc.archiveMergedWorkspaces).toHaveBeenCalledWith("p1", "/repo", ["a", "b"], ["b"]);
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

  it("keeps the missions that changed since the offer, says why, and reads the offer again", async () => {
    mockIpc.archiveMergedWorkspaces.mockResolvedValueOnce({
      archived: ["b"],
      skipped: [{ workspaceId: "a", reason: "changed" }],
    });
    const done = await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a"), ws("b", "fix-b")]);
    expect(done).toEqual(["b"]);
    expect(useWorkspaceStore.getState().workspacesByProjectId.p1.map((w) => w.id)).toEqual(["a"]);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", title: 'Skipped "fix-a"', body: "fix-a has uncommitted changes." }),
    );
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archived "fix-b"' }));
    expect(mockIpc.mergedWorkspaces).toHaveBeenCalledWith("p1", "/repo");
  });

  it("archives nothing and says so when the call fails", async () => {
    mockIpc.archiveMergedWorkspaces.mockRejectedValueOnce("locked");
    expect(await archiveMergedMissions("p1", "/repo", [ws("a", "fix-a")])).toEqual([]);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Archive failed" }));
    expect(useWorkspaceStore.getState().workspacesByProjectId.p1).toHaveLength(2);
  });
});

describe("skippedBody", () => {
  it("gives each mission its reason, the first four", () => {
    expect(skippedBody([{ name: "fix-a", reason: "busy" }, { name: "fix-b", reason: "local-files" }])).toBe(
      "fix-a has a Talk turn or a Direct run going. fix-b now holds local files.",
    );
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `m${i}`, reason: "moved" as const }));
    expect(skippedBody(many)).toMatch(/m3 has commits after its merged PR\. And 2 more\.$/);
  });
});

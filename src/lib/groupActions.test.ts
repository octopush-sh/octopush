import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Group, Workspace } from "./types";

const mockIpc = vi.hoisted(() => ({
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setItemGroup: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: mockIpc }));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../components/Toasts", () => ({ pushToast }));

const { NEW_GROUP_NAME, createMissionGroup, moveMissionToGroup, ungroupMissions } = await import("./groupActions");
const { useGroupsStore, __resetGroupsStoreInFlight } = await import("../stores/groupsStore");
const { useRailGroupUi, __reloadRailGroupUi, GROUP_COLLAPSE_KEY } = await import("../stores/railGroupUiStore");
const { useWorkspaceStore } = await import("../stores/workspaceStore");

const group = (id: string, over: Partial<Group> = {}): Group => ({
  id,
  scope: "workspace",
  projectId: "p1",
  name: id,
  tint: null,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});
const ws = (id: string, groupId: string | null = null): Workspace => ({
  id,
  projectId: "p1",
  name: id,
  task: "",
  branch: id,
  worktreePath: null,
  setupScript: "",
  status: "active",
  createdAt: "",
  lastActive: "",
  glyph: null,
  tint: null,
  linkedIssueKey: null,
  fromBranch: null,
  groupId,
});
const seed = (rows: Workspace[]) => useWorkspaceStore.setState({ workspaces: rows, workspacesByProjectId: { p1: rows } });
const groupOf = (id: string) => useWorkspaceStore.getState().workspacesByProjectId.p1.find((w) => w.id === id)?.groupId ?? null;

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  __resetGroupsStoreInFlight();
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  __reloadRailGroupUi();
  useGroupsStore.setState({ groups: [], loaded: true });
  seed([]);
});

describe("groupActions", () => {
  it("createMissionGroup names it New group and opens the name in edit", async () => {
    seed([ws("w1")]);
    mockIpc.createGroup.mockResolvedValue(group("made", { name: NEW_GROUP_NAME }));
    expect(await createMissionGroup("p1", "w1")).toBe("made");
    expect(mockIpc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", projectId: "p1", name: "New group", memberIds: ["w1"] }),
    );
    expect(useRailGroupUi.getState().renamingId).toBe("made");
    expect(groupOf("w1")).toBe("made");
  });

  it("createMissionGroup leaves the rail alone when the backend refuses", async () => {
    mockIpc.createGroup.mockRejectedValue("other: no such project");
    expect(await createMissionGroup("p1")).toBeNull();
    expect(useRailGroupUi.getState().renamingId).toBeNull();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });

  it("moving a mission into a folded group unfolds it; moving out touches no fold", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seed([ws("w1")]);
    useRailGroupUi.getState().setCollapsed("g1", true);
    await moveMissionToGroup("w1", "g1");
    expect(useRailGroupUi.getState().collapsed).toEqual({});
    expect(mockIpc.setItemGroup).toHaveBeenLastCalledWith("workspace", "w1", "g1");
    await moveMissionToGroup("w1", null);
    expect(mockIpc.setItemGroup).toHaveBeenLastCalledWith("workspace", "w1", null);
    expect(groupOf("w1")).toBeNull();
  });

  it("Undo after Ungroup regroups only the missions that are still loose", async () => {
    useGroupsStore.setState({ groups: [group("g1", { name: "Fixes", tint: "indigo" }), group("g2", { sortOrder: 1 })] });
    seed([ws("w1", "g1"), ws("w2", "g1"), ws("w3")]);
    useRailGroupUi.getState().setCollapsed("g1", true);
    await ungroupMissions("g1");
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g1");
    expect(useRailGroupUi.getState().collapsed).toEqual({}); // its fold is forgotten
    const toast = pushToast.mock.calls.at(-1)![0];
    expect(toast).toMatchObject({ title: 'Ungrouped "Fixes"', body: "Its missions are back in the list." });

    // Meanwhile one of them joined another group.
    await moveMissionToGroup("w2", "g2");
    mockIpc.createGroup.mockResolvedValue(group("again", { name: "Fixes", tint: "indigo" }));
    toast.action.onClick();
    await vi.waitFor(() => expect(groupOf("w1")).toBe("again"));
    expect(mockIpc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Fixes", tint: "indigo", projectId: "p1", memberIds: ["w1"] }),
    );
    expect(groupOf("w2")).toBe("g2");
  });

  it("a refused Ungroup shows no Undo", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seed([ws("w1", "g1")]);
    mockIpc.deleteGroup.mockRejectedValue("other: locked");
    await ungroupMissions("g1");
    expect(groupOf("w1")).toBe("g1");
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatchObject({ level: "error" });
  });

  it("Undo does nothing once the project is closed: no invisible empty group", async () => {
    useGroupsStore.setState({ groups: [group("g1", { name: "Fixes" })] });
    seed([ws("w1", "g1")]);
    await ungroupMissions("g1");
    const toast = pushToast.mock.calls.at(-1)![0];
    // Closing the project drops its rows from the rail.
    useWorkspaceStore.getState().pruneProject("p1");
    toast.action.onClick();
    await Promise.resolve();
    expect(mockIpc.createGroup).not.toHaveBeenCalled();
  });
});

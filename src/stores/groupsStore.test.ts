/**
 * Tests for groupsStore: every change but `create` shows at once and is rolled
 * back when the backend refuses it, in this store and in the project and
 * workspace stores that hold the members' `groupId`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Group, ProjectInfo, Workspace } from "../lib/types";

const mockIpc = {
  listWorkspaces: vi.fn<(projectId: string) => Promise<Workspace[]>>(),
  listRecentProjects: vi.fn<() => Promise<ProjectInfo[]>>(),
  listGroups: vi.fn<() => Promise<Group[]>>(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupTint: vi.fn(),
  setGroupOrder: vi.fn(),
  deleteGroup: vi.fn(),
  setItemGroup: vi.fn(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));
const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

const { useGroupsStore, sortGroups, __resetGroupsStoreInFlight } = await import("./groupsStore");
const { __resetMembershipGuard } = await import("../lib/membershipGuard");
const { useProjectStore } = await import("./projectStore");
const { useWorkspaceStore } = await import("./workspaceStore");

function group(id: string, over: Partial<Group> = {}): Group {
  return {
    id,
    scope: "workspace",
    projectId: "p1",
    name: id,
    tint: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function project(id: string, groupId: string | null = null): ProjectInfo {
  return { id, name: id, path: `/repo/${id}`, jiraProjectKey: null, pinned: false, tint: null, groupId };
}

function workspace(id: string, groupId: string | null = null, projectId = "p1"): Workspace {
  return {
    id,
    projectId,
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
  };
}

/** A call the test settles by hand, to look at the store while it is in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedWorkspaces(list: Workspace[]) {
  const byProject: Record<string, Workspace[]> = {};
  for (const w of list) (byProject[w.projectId] ??= []).push(w);
  useWorkspaceStore.setState({ workspaces: byProject.p1 ?? [], workspacesByProjectId: byProject });
}

/** A workspace's group, read from both lists the rail uses. */
function workspaceGroup(id: string) {
  const s = useWorkspaceStore.getState();
  const flat = s.workspaces.find((w) => w.id === id)?.groupId ?? null;
  const mapped =
    Object.values(s.workspacesByProjectId)
      .flat()
      .find((w) => w.id === id)?.groupId ?? null;
  expect(flat).toBe(mapped);
  return mapped;
}

const projectGroup = (id: string) =>
  useProjectStore.getState().recent.find((p) => p.id === id)?.groupId ?? null;
const groupNames = () => useGroupsStore.getState().groups.map((g) => g.name);

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset();
  pushToast.mockReset();
  __resetGroupsStoreInFlight();
  __resetMembershipGuard();
  useGroupsStore.setState({ groups: [], loaded: false });
  useProjectStore.setState({ current: null, recent: [], closed: [] });
  useWorkspaceStore.setState({ workspaces: [], workspacesByProjectId: {} });
});

describe("groupsStore: load and order", () => {
  it("loads the groups in the backend's listing order", async () => {
    mockIpc.listGroups.mockResolvedValue([
      group("b", { sortOrder: 1 }),
      group("top", { scope: "project", projectId: null }),
      group("a", { sortOrder: 0 }),
    ]);
    await useGroupsStore.getState().load();
    expect(useGroupsStore.getState().loaded).toBe(true);
    expect(groupNames()).toEqual(["top", "a", "b"]);
  });

  it("keeps what it had, and says so, when the load fails", async () => {
    useGroupsStore.setState({ groups: [group("a")] });
    mockIpc.listGroups.mockRejectedValue("db error: locked");
    await useGroupsStore.getState().load();
    expect(groupNames()).toEqual(["a"]);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Couldn't load groups" }),
    );
  });

  it("sortGroups runs each project's groups by sortOrder, oldest first on a tie", () => {
    const sorted = sortGroups([
      group("p2-a", { projectId: "p2" }),
      group("late", { sortOrder: 1, createdAt: "2026-02-01T00:00:00Z" }),
      group("early", { sortOrder: 1, createdAt: "2026-01-01T00:00:00Z" }),
      group("first", { sortOrder: 0 }),
    ]);
    expect(sorted.map((g) => g.id)).toEqual(["first", "early", "late", "p2-a"]);
  });
});

describe("groupsStore: create", () => {
  it("adds the group where the backend put it and moves the members in", async () => {
    useGroupsStore.setState({
      groups: [group("a", { sortOrder: 0 }), group("b", { sortOrder: 1 }), group("other", { projectId: "p2" })],
    });
    seedWorkspaces([workspace("w1", "a"), workspace("w2"), workspace("x1", null, "p2")]);
    // The backend placed the new group first and shifted its siblings.
    const created = group("new", { name: "PR reviews", sortOrder: 0, tint: "indigo" });
    mockIpc.createGroup.mockResolvedValue(created);

    const input = {
      scope: "workspace" as const,
      projectId: "p1",
      name: "PR reviews",
      tint: "indigo" as const,
      memberIds: ["w1", "w2"],
    };
    const result = await useGroupsStore.getState().create(input);

    expect(result).toEqual(created);
    expect(mockIpc.createGroup).toHaveBeenCalledWith(input);
    expect(useGroupsStore.getState().groups.map((g) => [g.id, g.sortOrder])).toEqual([
      ["new", 0],
      ["a", 1],
      ["b", 2],
      ["other", 0],
    ]);
    // One membership per item: w1 left "a".
    expect(workspaceGroup("w1")).toBe("new");
    expect(workspaceGroup("w2")).toBe("new");
    expect(workspaceGroup("x1")).toBeNull();
  });

  it("changes nothing when the backend refuses", async () => {
    seedWorkspaces([workspace("w1")]);
    mockIpc.createGroup.mockRejectedValue("other: A workspace can only join a group in its own project.");

    const result = await useGroupsStore
      .getState()
      .create({ scope: "workspace", projectId: "p1", name: "PR reviews", memberIds: ["w1"] });

    expect(result).toBeNull();
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(workspaceGroup("w1")).toBeNull();
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "Couldn't create the group",
      body: "A workspace can only join a group in its own project.",
    });
  });
});

describe("groupsStore: optimistic updates and rollback", () => {
  it("rename shows at once, trimmed, and stays when the backend accepts", async () => {
    useGroupsStore.setState({ groups: [group("a", { name: "Old" })] });
    const call = deferred();
    mockIpc.renameGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().rename("a", "  PR reviews ");
    expect(groupNames()).toEqual(["PR reviews"]);
    expect(mockIpc.renameGroup).toHaveBeenCalledWith("a", "PR reviews");

    call.resolve();
    expect(await pending).toBe(true);
    expect(groupNames()).toEqual(["PR reviews"]);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("rename rolls back when the backend refuses", async () => {
    useGroupsStore.setState({ groups: [group("a", { name: "Old" })] });
    const call = deferred();
    mockIpc.renameGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().rename("a", "New");
    expect(groupNames()).toEqual(["New"]);

    call.reject("other: Group not found.");
    expect(await pending).toBe(false);
    expect(groupNames()).toEqual(["Old"]);
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "Couldn't rename the group",
      body: "Group not found.",
    });
  });

  it("a failed rename doesn't undo a newer one", async () => {
    useGroupsStore.setState({ groups: [group("a", { name: "Old" })] });
    const first = deferred();
    mockIpc.renameGroup.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    const pending = useGroupsStore.getState().rename("a", "First");
    await useGroupsStore.getState().rename("a", "Second");
    first.reject("db error: locked");
    await pending;
    expect(groupNames()).toEqual(["Second"]);
  });

  it("a blank rename is ignored without a call", async () => {
    useGroupsStore.setState({ groups: [group("a", { name: "Old" })] });
    expect(await useGroupsStore.getState().rename("a", "   ")).toBe(false);
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
    expect(groupNames()).toEqual(["Old"]);
  });

  it("tint shows at once and rolls back when refused", async () => {
    useGroupsStore.setState({ groups: [group("a", { tint: "rouge" })] });
    const tint = () => useGroupsStore.getState().groups[0].tint;
    const call = deferred();
    mockIpc.setGroupTint.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().setTint("a", null);
    expect(tint()).toBeNull();
    expect(mockIpc.setGroupTint).toHaveBeenCalledWith("a", null);

    call.reject("db error: locked");
    expect(await pending).toBe(false);
    expect(tint()).toBe("rouge");

    mockIpc.setGroupTint.mockResolvedValue(undefined);
    expect(await useGroupsStore.getState().setTint("a", "verdigris")).toBe(true);
    expect(tint()).toBe("verdigris");
  });

  it("reorder shows at once and rolls back when refused", async () => {
    useGroupsStore.setState({
      groups: [group("a", { sortOrder: 0 }), group("b", { sortOrder: 3 }), group("c", { sortOrder: 7 })],
    });
    const order = () => useGroupsStore.getState().groups.map((g) => [g.id, g.sortOrder]);
    const call = deferred();
    mockIpc.setGroupOrder.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().setOrder(["c", "a", "b"]);
    expect(order()).toEqual([["c", 0], ["a", 1], ["b", 2]]);
    expect(mockIpc.setGroupOrder).toHaveBeenCalledWith(["c", "a", "b"]);

    call.reject("db error: locked");
    expect(await pending).toBe(false);
    expect(order()).toEqual([["a", 0], ["b", 3], ["c", 7]]);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't reorder the groups" }),
    );
  });

  it("removing a group ungroups its members at once and keeps them", async () => {
    useGroupsStore.setState({ groups: [group("a"), group("b", { sortOrder: 1 })] });
    seedWorkspaces([workspace("w1", "a"), workspace("w2", "a"), workspace("w3", "b")]);
    const call = deferred();
    mockIpc.deleteGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().remove("a");
    expect(groupNames()).toEqual(["b"]);
    expect(workspaceGroup("w1")).toBeNull();
    expect(workspaceGroup("w2")).toBeNull();
    expect(workspaceGroup("w3")).toBe("b");
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(3);

    call.resolve();
    expect(await pending).toBe(true);
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("a");
    expect(groupNames()).toEqual(["b"]);
  });

  it("a refused removal puts the group and its members back", async () => {
    useGroupsStore.setState({ groups: [group("a"), group("b", { sortOrder: 1 })] });
    seedWorkspaces([workspace("w1", "a"), workspace("w2", "a"), workspace("w3", "b")]);
    const call = deferred();
    mockIpc.deleteGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().remove("a");
    expect(groupNames()).toEqual(["b"]);
    // While it is in flight, w2 is moved elsewhere: the rollback leaves it.
    mockIpc.setItemGroup.mockResolvedValue(undefined);
    await useGroupsStore.getState().moveItem("workspace", "w2", "b");

    call.reject("db error: locked");
    expect(await pending).toBe(false);
    expect(groupNames()).toEqual(["a", "b"]);
    expect(workspaceGroup("w1")).toBe("a");
    expect(workspaceGroup("w2")).toBe("b");
    expect(workspaceGroup("w3")).toBe("b");
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't remove the group" }),
    );
  });

  it("moving a workspace shows at once, in both workspace lists", async () => {
    useGroupsStore.setState({ groups: [group("a"), group("b", { sortOrder: 1 })] });
    seedWorkspaces([workspace("w1", "a"), workspace("w2")]);
    const call = deferred();
    mockIpc.setItemGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().moveItem("workspace", "w1", "b");
    expect(workspaceGroup("w1")).toBe("b");
    expect(workspaceGroup("w2")).toBeNull();
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("workspace", "w1", "b");

    call.resolve();
    expect(await pending).toBe(true);
    expect(workspaceGroup("w1")).toBe("b");
    // An emptied group stays.
    expect(groupNames()).toEqual(["a", "b"]);
  });

  it("a refused move puts the workspace back in its group", async () => {
    useGroupsStore.setState({ groups: [group("a"), group("far", { projectId: "p2" })] });
    seedWorkspaces([workspace("w1", "a")]);
    const call = deferred();
    mockIpc.setItemGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().moveItem("workspace", "w1", "far");
    expect(workspaceGroup("w1")).toBe("far");

    call.reject("other: A workspace can only join a group in its own project.");
    expect(await pending).toBe(false);
    expect(workspaceGroup("w1")).toBe("a");
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "Couldn't move the workspace",
      body: "A workspace can only join a group in its own project.",
    });
  });

  it("moves a project out of its group, and back when refused", async () => {
    const top = group("top", { scope: "project", projectId: null });
    useGroupsStore.setState({ groups: [top] });
    useProjectStore.setState({ current: project("p1", "top"), recent: [project("p1", "top"), project("p2")] });
    const call = deferred();
    mockIpc.setItemGroup.mockReturnValue(call.promise);

    const pending = useGroupsStore.getState().moveItem("project", "p1", null);
    expect(projectGroup("p1")).toBeNull();
    expect(useProjectStore.getState().current?.groupId).toBeNull();
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "p1", null);

    call.reject("db error: locked");
    expect(await pending).toBe(false);
    expect(projectGroup("p1")).toBe("top");
    expect(useProjectStore.getState().current?.groupId).toBe("top");
    expect(projectGroup("p2")).toBeNull();
  });

  it("moving an item to the group it is already in sends nothing", async () => {
    seedWorkspaces([workspace("w1", "a")]);
    expect(await useGroupsStore.getState().moveItem("workspace", "w1", "a")).toBe(true);
    expect(mockIpc.setItemGroup).not.toHaveBeenCalled();
  });
});

describe("groupsStore: a reload never undoes a change it could not have seen", () => {
  it("concurrent loads share one read, then read once more for the later caller", async () => {
    const first = deferred<Group[]>();
    mockIpc.listGroups.mockReturnValueOnce(first.promise).mockResolvedValue([group("a"), group("b", { sortOrder: 1 })]);
    const one = useGroupsStore.getState().load();
    const two = useGroupsStore.getState().load();
    expect(mockIpc.listGroups).toHaveBeenCalledTimes(1);
    first.resolve([group("a")]);
    await Promise.all([one, two]);
    // The second caller asked after the first read began, so it gets a fresh one.
    expect(mockIpc.listGroups).toHaveBeenCalledTimes(2);
    expect(groupNames()).toEqual(["a", "b"]);
  });

  it("a read that raced a create is thrown away and repeated, so the new group stays", async () => {
    useGroupsStore.setState({ groups: [group("a")] });
    const stale = deferred<Group[]>();
    const created = group("made", { sortOrder: 1 });
    mockIpc.listGroups.mockReturnValueOnce(stale.promise).mockResolvedValue([group("a"), created]);
    mockIpc.createGroup.mockResolvedValue(created);

    const loading = useGroupsStore.getState().load();
    await useGroupsStore.getState().create({ scope: "workspace", projectId: "p1", name: "made" });
    // The read began before the create: it does not know the new group.
    stale.resolve([group("a")]);
    await loading;

    expect(groupNames()).toEqual(["a", "made"]);
    expect(mockIpc.listGroups).toHaveBeenCalledTimes(2);
  });

  it("a read waits for a rename in flight instead of putting the old name back", async () => {
    useGroupsStore.setState({ groups: [group("a", { name: "Old" })] });
    const renaming = deferred();
    mockIpc.renameGroup.mockReturnValue(renaming.promise);
    mockIpc.listGroups.mockResolvedValue([group("a", { name: "New" })]);

    const rename = useGroupsStore.getState().rename("a", "New");
    const loading = useGroupsStore.getState().load();
    await Promise.resolve();
    expect(mockIpc.listGroups).not.toHaveBeenCalled();
    renaming.resolve();
    await Promise.all([rename, loading]);
    expect(mockIpc.listGroups).toHaveBeenCalledTimes(1);
    expect(groupNames()).toEqual(["New"]);
  });

  it("a move survives a loadAllWorkspaces that was already in flight", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seedWorkspaces([workspace("w1"), workspace("w2")]);
    const staleRows = deferred<Workspace[]>();
    mockIpc.listWorkspaces.mockReturnValueOnce(staleRows.promise);
    mockIpc.setItemGroup.mockResolvedValue(undefined);

    // The reload reads the rows, then the move lands, then the reload returns.
    const reload = useWorkspaceStore.getState().loadAllWorkspaces(["p1"]);
    await useGroupsStore.getState().moveItem("workspace", "w1", "g1");
    staleRows.resolve([workspace("w1"), workspace("w2")]);
    await reload;

    expect(useWorkspaceStore.getState().workspacesByProjectId.p1.find((w) => w.id === "w1")?.groupId).toBe("g1");
    expect(useWorkspaceStore.getState().workspacesByProjectId.p1.find((w) => w.id === "w2")?.groupId).toBeNull();
  });

  it("a move still in flight survives a reload that lands before the backend answers", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seedWorkspaces([workspace("w1")]);
    const moving = deferred();
    mockIpc.setItemGroup.mockReturnValue(moving.promise);
    mockIpc.listWorkspaces.mockResolvedValue([workspace("w1")]);

    const move = useGroupsStore.getState().moveItem("workspace", "w1", "g1");
    await useWorkspaceStore.getState().load("p1");
    expect(workspaceGroup("w1")).toBe("g1");
    moving.resolve();
    await move;
    expect(workspaceGroup("w1")).toBe("g1");
  });

  it("a refused move is not kept alive by the guard", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seedWorkspaces([workspace("w1")]);
    mockIpc.setItemGroup.mockRejectedValue("other: refused");
    mockIpc.listWorkspaces.mockResolvedValue([workspace("w1")]);

    await useGroupsStore.getState().moveItem("workspace", "w1", "g1");
    await useWorkspaceStore.getState().load("p1");
    expect(workspaceGroup("w1")).toBeNull();
  });

  it("a reload that began after the move settled is trusted", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seedWorkspaces([workspace("w1")]);
    mockIpc.setItemGroup.mockResolvedValue(undefined);
    await useGroupsStore.getState().moveItem("workspace", "w1", "g1");
    // Something else (another window, a later action) moved it out again.
    mockIpc.listWorkspaces.mockResolvedValue([workspace("w1")]);
    await useWorkspaceStore.getState().load("p1");
    expect(workspaceGroup("w1")).toBeNull();
  });

  it("a project move survives a loadRecent that was already in flight", async () => {
    useGroupsStore.setState({ groups: [group("top", { scope: "project", projectId: null })] });
    useProjectStore.setState({ recent: [project("p1"), project("p2")] });
    const staleRows = deferred<ProjectInfo[]>();
    mockIpc.listRecentProjects.mockReturnValueOnce(staleRows.promise);
    mockIpc.setItemGroup.mockResolvedValue(undefined);

    const reload = useProjectStore.getState().loadRecent();
    await useGroupsStore.getState().moveItem("project", "p1", "top");
    staleRows.resolve([project("p1"), project("p2")]);
    await reload;

    expect(projectGroup("p1")).toBe("top");
    expect(projectGroup("p2")).toBeNull();
  });

  it("the members of a new group survive a reload that began before it existed", async () => {
    seedWorkspaces([workspace("w1")]);
    const staleRows = deferred<Workspace[]>();
    mockIpc.listWorkspaces.mockReturnValueOnce(staleRows.promise);
    mockIpc.createGroup.mockResolvedValue(group("made"));

    const reload = useWorkspaceStore.getState().load("p1");
    await useGroupsStore.getState().create({ scope: "workspace", projectId: "p1", name: "made", memberIds: ["w1"] });
    staleRows.resolve([workspace("w1")]);
    await reload;
    expect(workspaceGroup("w1")).toBe("made");
  });
});

describe("groupsStore: order and pruning", () => {
  it("setOrder always sends the complete run of siblings", async () => {
    useGroupsStore.setState({
      groups: sortGroups([
        group("a", { sortOrder: 0 }),
        group("b", { sortOrder: 1 }),
        group("c", { sortOrder: 2 }),
        group("other", { projectId: "p2", sortOrder: 0 }),
      ]),
    });
    mockIpc.setGroupOrder.mockResolvedValue(undefined);
    // Only the moved group is named: the rest follow in their current order.
    await useGroupsStore.getState().setOrder(["c"]);
    expect(mockIpc.setGroupOrder).toHaveBeenCalledWith(["c", "a", "b"]);
    expect(groupNames()).toEqual(["c", "a", "b", "other"]);
  });

  it("setOrder ignores ids that are not siblings, and an unchanged order sends nothing", async () => {
    useGroupsStore.setState({
      groups: sortGroups([group("a", { sortOrder: 0 }), group("b", { sortOrder: 1 }), group("other", { projectId: "p2" })]),
    });
    mockIpc.setGroupOrder.mockResolvedValue(undefined);
    expect(await useGroupsStore.getState().setOrder(["a", "b"])).toBe(true);
    expect(mockIpc.setGroupOrder).not.toHaveBeenCalled();
    await useGroupsStore.getState().setOrder(["b", "other", "a"]);
    expect(mockIpc.setGroupOrder).toHaveBeenCalledWith(["b", "a"]);
  });

  it("a failed reorder doesn't undo a newer one", async () => {
    useGroupsStore.setState({
      groups: sortGroups([group("a", { sortOrder: 0 }), group("b", { sortOrder: 1 }), group("c", { sortOrder: 2 })]),
    });
    const first = deferred();
    mockIpc.setGroupOrder.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    const failing = useGroupsStore.getState().setOrder(["c", "a", "b"]);
    await useGroupsStore.getState().setOrder(["b", "c", "a"]);
    first.reject("other: locked");
    expect(await failing).toBe(false);
    // The newer order, which the backend accepted, stands.
    expect(groupNames()).toEqual(["b", "c", "a"]);
  });

  it("pruneProject forgets a closed or deleted project's groups only", () => {
    useGroupsStore.setState({
      groups: sortGroups([
        group("mine"),
        group("theirs", { projectId: "p2" }),
        group("top", { scope: "project", projectId: null }),
      ]),
    });
    useGroupsStore.getState().pruneProject("p1");
    expect(groupNames()).toEqual(["top", "theirs"]);
  });
});

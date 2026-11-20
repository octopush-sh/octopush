import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Group, ProjectInfo, Workspace } from "./types";

const mockIpc = vi.hoisted(() => ({
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setGroupOrder: vi.fn(),
  setItemGroup: vi.fn(),
  setProjectOrder: vi.fn(),
  listRecentProjects: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: mockIpc }));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../components/Toasts", () => ({ pushToast }));

const {
  NEW_GROUP_NAME,
  __resetJustCreated,
  cancelNewGroup,
  createMissionGroup,
  createProjectGroup,
  moveMissionToGroup,
  moveMissionsToGroup,
  moveProjectToGroup,
  revealGroup,
  ungroupMissions,
  ungroupProjects,
} = await import("./groupActions");
const { useProjectStore, __resetProjectOrderInFlight } = await import("../stores/projectStore");
const { __resetMembershipGuard } = await import("./membershipGuard");
const { layoutProjects, projectGroupsOf, stepEmptySection } = await import("./railGroups");
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
  __resetProjectOrderInFlight();
  __resetMembershipGuard();
  __resetJustCreated();
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  __reloadRailGroupUi();
  useGroupsStore.setState({ groups: [], loaded: true });
  seed([]);
  useProjectStore.setState({ current: null, recent: [], closed: [] });
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

  it("createMissionGroup puts every selected mission in the one create_group call", async () => {
    seed([ws("w1"), ws("w2"), ws("w3")]);
    mockIpc.createGroup.mockResolvedValue(group("made", { name: NEW_GROUP_NAME }));
    await createMissionGroup("p1", ["w1", "w3"]);
    expect(mockIpc.createGroup).toHaveBeenCalledTimes(1);
    expect(mockIpc.createGroup).toHaveBeenCalledWith(expect.objectContaining({ memberIds: ["w1", "w3"] }));
    expect([groupOf("w1"), groupOf("w2"), groupOf("w3")]).toEqual(["made", null, "made"]);
  });

  it("moveMissionsToGroup moves each mission not already there, and unfolds the target", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seed([ws("w1", "g1"), ws("w2"), ws("w3")]);
    useRailGroupUi.getState().setCollapsed("g1", true);
    expect(await moveMissionsToGroup(["w1", "w2", "w3"], "g1")).toBe(true);
    expect(mockIpc.setItemGroup).toHaveBeenCalledTimes(2);
    expect([groupOf("w1"), groupOf("w2"), groupOf("w3")]).toEqual(["g1", "g1", "g1"]);
    expect(useRailGroupUi.getState().collapsed).toEqual({});
  });

  it("revealGroup unfolds the group and asks the rail to show it", () => {
    useRailGroupUi.getState().setCollapsed("g1", true);
    revealGroup("g1");
    expect(useRailGroupUi.getState().collapsed).toEqual({});
    expect(useRailGroupUi.getState().revealId).toBe("g1");
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

// ───────────────────────────── project groups ─────────────────────────────

const section = (id: string, over: Partial<Group> = {}) => group(id, { scope: "project", projectId: null, ...over });
const project = (id: string, groupId: string | null = null): ProjectInfo => ({
  id,
  name: id,
  path: `/code/${id}`,
  jiraProjectKey: null,
  pinned: false,
  tint: null,
  groupId,
});
/** The projects the rail lists; a reload after a reorder answers with the same rows. */
const seedProjects = (rows: ProjectInfo[], current: ProjectInfo | null = null) => {
  useProjectStore.setState({ recent: rows, current });
  mockIpc.listRecentProjects.mockImplementation(async () => useProjectStore.getState().recent);
};
const sectionOf = (id: string) => useProjectStore.getState().recent.find((p) => p.id === id)?.groupId ?? null;
const ids = () => useProjectStore.getState().recent.map((p) => p.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: undefined) => void;
  const promise = new Promise<undefined>((r) => (resolve = r));
  return { promise, resolve };
}

describe("groupActions: project groups", () => {
  it("createProjectGroup makes a project group around the project and opens its name in edit", async () => {
    seedProjects([project("api"), project("web")]);
    mockIpc.createGroup.mockResolvedValue(section("g-new", { name: NEW_GROUP_NAME }));

    expect(await createProjectGroup("api")).toBe("g-new");

    expect(mockIpc.createGroup).toHaveBeenCalledWith({
      scope: "project",
      name: NEW_GROUP_NAME,
      memberIds: ["api"],
    });
    expect(sectionOf("api")).toBe("g-new");
    expect(sectionOf("web")).toBeNull();
    expect(useRailGroupUi.getState().renamingId).toBe("g-new");
  });

  it("createProjectGroup changes nothing when the backend refuses", async () => {
    seedProjects([project("api")]);
    mockIpc.createGroup.mockRejectedValue(new Error("other: no"));
    expect(await createProjectGroup("api")).toBeNull();
    expect(sectionOf("api")).toBeNull();
    expect(useRailGroupUi.getState().renamingId).toBeNull();
  });

  it("moveProjectToGroup unfolds the group and makes the project its last one in the stored order", async () => {
    // a · [client: api web] · dotfiles
    seedProjects([project("a"), project("api", "g-client"), project("web", "g-client"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    useRailGroupUi.getState().setCollapsed("g-client", true);

    expect(await moveProjectToGroup("a", "g-client")).toBe(true);
    await settle();

    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "a", "g-client");
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["api", "web", "a", "dotfiles"]);
    expect(sectionOf("a")).toBe("g-client");
    expect(useRailGroupUi.getState().collapsed["g-client"]).toBeUndefined();
  });

  it("joining a group whose last project it already follows persists no order", async () => {
    seedProjects([project("api", "g-client"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    await moveProjectToGroup("dotfiles", "g-client");
    await settle();
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "dotfiles", "g-client");
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
  });

  it("leaving a group keeps the project's place: no order is written", async () => {
    seedProjects([project("api", "g-client"), project("web", "g-client")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    expect(await moveProjectToGroup("api", null)).toBe(true);
    await settle();
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "api", null);
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
    expect(sectionOf("api")).toBeNull();
  });

  it("a drag hands its own order over, or none", async () => {
    seedProjects([project("a"), project("api", "g-client")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    await moveProjectToGroup("a", "g-client", null);
    await settle();
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
  });

  it("a refused move rolls back and persists no order", async () => {
    seedProjects([project("a"), project("api", "g-client"), project("web", "g-client"), project("b")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    mockIpc.setItemGroup.mockRejectedValue(new Error("other: no"));
    expect(await moveProjectToGroup("b", "g-client")).toBe(false);
    await settle();
    expect(sectionOf("b")).toBeNull();
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "Couldn't move b",
      body: "Your rail is back as it was.",
    });
    expect(ids()).toEqual(["a", "api", "web", "b"]);
  });

  it("membership and order reach the store together, before the backend answers", async () => {
    seedProjects([project("a"), project("api", "g-client"), project("web", "g-client"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    const moving = deferred();
    mockIpc.setItemGroup.mockReturnValue(moving.promise);
    const seen: Array<[string | null, string[]]> = [];
    const stop = useProjectStore.subscribe(() => seen.push([sectionOf("a"), ids()]));

    const done = moveProjectToGroup("a", "g-client");

    // One store update, holding both: the group never draws a in the wrong place.
    expect(seen).toEqual([["g-client", ["api", "web", "a", "dotfiles"]]]);
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
    moving.resolve(undefined);
    expect(await done).toBe(true);
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["api", "web", "a", "dotfiles"]);
    stop();
  });

  it("a refused order puts back the order and the membership, in the store and the backend", async () => {
    seedProjects([project("a"), project("api", "g-client"), project("web", "g-client"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    mockIpc.setProjectOrder.mockRejectedValue(new Error("other: database is locked"));

    expect(await moveProjectToGroup("a", "g-client")).toBe(false);

    expect(sectionOf("a")).toBeNull();
    expect(ids()).toEqual(["a", "api", "web", "dotfiles"]);
    expect(mockIpc.setItemGroup).toHaveBeenNthCalledWith(1, "project", "a", "g-client");
    expect(mockIpc.setItemGroup).toHaveBeenNthCalledWith(2, "project", "a", null);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatchObject({ title: "Couldn't move a", body: "Your rail is back as it was." });
  });

  it("a dragged project leaving its group with a new order rolls both back when refused", async () => {
    seedProjects([project("api", "g-client"), project("web", "g-client"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    mockIpc.setItemGroup.mockRejectedValue(new Error("other: no"));

    expect(await moveProjectToGroup("web", null, ["api", "dotfiles", "web"])).toBe(false);

    expect(sectionOf("web")).toBe("g-client");
    expect(ids()).toEqual(["api", "web", "dotfiles"]);
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  it("a reload that read the old order while the move was in flight keeps the new one", async () => {
    const rows = [project("a"), project("api", "g-client"), project("web", "g-client")];
    seedProjects(rows);
    useGroupsStore.setState({ groups: [section("g-client")] });
    const ordering = deferred();
    mockIpc.setProjectOrder.mockReturnValue(ordering.promise);
    // The database still holds the old rows.
    mockIpc.listRecentProjects.mockResolvedValue(rows);

    const done = moveProjectToGroup("a", "g-client");
    await useProjectStore.getState().loadRecent();

    expect(ids()).toEqual(["api", "web", "a"]);
    expect(sectionOf("a")).toBe("g-client");
    ordering.resolve(undefined);
    expect(await done).toBe(true);
  });

  it("the open project counts even before the list has it", async () => {
    const fresh = project("fresh");
    seedProjects([project("api", "g-client")], fresh);
    useGroupsStore.setState({ groups: [section("g-client")] });
    // fresh stands last, right after the group's last project: nothing to reorder.
    await moveProjectToGroup("fresh", "g-client");
    await settle();
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "fresh", "g-client");
    expect(useProjectStore.getState().current?.groupId).toBe("g-client");
  });

  it("ungroupProjects keeps the projects and offers Undo, which regroups the ones still loose", async () => {
    seedProjects([project("api", "g-client"), project("web", "g-client"), project("other")]);
    useGroupsStore.setState({ groups: [section("g-client", { name: "Client work", tint: "verdigris" })] });
    useRailGroupUi.getState().setCollapsed("g-client", true);

    await ungroupProjects("g-client");

    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-client");
    expect(useGroupsStore.getState().groups).toEqual([]);
    expect(sectionOf("api")).toBeNull();
    expect(sectionOf("web")).toBeNull();
    expect(useRailGroupUi.getState().collapsed["g-client"]).toBeUndefined();
    const toast = pushToast.mock.calls[0][0];
    expect(toast.title).toBe('Ungrouped "Client work"');
    expect(toast.body).toBe("Its projects are back in the list.");
    expect(toast.action.label).toBe("Undo");

    // `web` joined another group meanwhile: Undo leaves it there.
    useGroupsStore.setState({ groups: [section("g-side")] });
    useProjectStore.setState((s) => ({ recent: s.recent.map((p) => (p.id === "web" ? { ...p, groupId: "g-side" } : p)) }));
    mockIpc.createGroup.mockResolvedValue(section("g-again", { name: "Client work", tint: "verdigris" }));
    toast.action.onClick();
    await settle();
    expect(mockIpc.createGroup).toHaveBeenCalledWith({
      scope: "project",
      name: "Client work",
      tint: "verdigris",
      memberIds: ["api"],
    });
  });

  it("one project reads in the singular; an empty group goes with no toast", async () => {
    seedProjects([project("api", "g-one")]);
    useGroupsStore.setState({ groups: [section("g-one"), section("g-empty")] });
    await ungroupProjects("g-one");
    expect(pushToast.mock.calls[0][0].body).toBe("Its project is back in the list.");
    pushToast.mockReset();
    await ungroupProjects("g-empty");
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-empty");
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("Move up / Move down on an empty project group trades places among the empty ones", async () => {
    // [client: api] · [empty-a] · [empty-b], stored as client 0, empty-a 1, empty-b 2.
    seedProjects([project("api", "g-client")]);
    useGroupsStore.setState({
      groups: [section("g-client"), section("g-empty-a", { sortOrder: 1 }), section("g-empty-b", { sortOrder: 2 })],
    });
    const layout = layoutProjects(useProjectStore.getState().recent, projectGroupsOf(useGroupsStore.getState().groups));
    expect(stepEmptySection(layout, "g-empty-a", -1)).toBeNull();
    const down = stepEmptySection(layout, "g-empty-a", 1);
    expect(down).toEqual(["g-client", "g-empty-b", "g-empty-a"]);
    mockIpc.setGroupOrder.mockResolvedValue(undefined);
    await useGroupsStore.getState().setOrder(down!);
    expect(mockIpc.setGroupOrder).toHaveBeenCalledWith(["g-client", "g-empty-b", "g-empty-a"]);
    const after = layoutProjects(useProjectStore.getState().recent, projectGroupsOf(useGroupsStore.getState().groups));
    expect(after.map((item) => (item.kind === "section" ? item.group.id : item.project.id))).toEqual([
      "g-client",
      "g-empty-b",
      "g-empty-a",
    ]);
  });

  it("Undo makes no group when every project has gone or been grouped again", async () => {
    seedProjects([project("api", "g-client")]);
    useGroupsStore.setState({ groups: [section("g-client")] });
    await ungroupProjects("g-client");
    useProjectStore.setState({ recent: [] });
    pushToast.mock.calls[0][0].action.onClick();
    await settle();
    expect(mockIpc.createGroup).not.toHaveBeenCalled();
  });
});

describe("groupActions: Escape on a new group's name", () => {
  it("cancels a project group made from a project: it goes, and the project returns to its old group", async () => {
    // a · [old: api web] · dotfiles; New group on web.
    seedProjects([project("a"), project("api", "g-old"), project("web", "g-old"), project("dotfiles")]);
    useGroupsStore.setState({ groups: [section("g-old")] });
    mockIpc.createGroup.mockResolvedValue(section("g-new", { name: NEW_GROUP_NAME, sortOrder: 1 }));
    await createProjectGroup("web");
    expect(sectionOf("web")).toBe("g-new");

    expect(await cancelNewGroup("g-new")).toBe(true);

    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-new");
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "web", "g-old");
    expect(useGroupsStore.getState().groups.map((g) => g.id)).toEqual(["g-old"]);
    expect(sectionOf("web")).toBe("g-old");
    expect(ids()).toEqual(["a", "api", "web", "dotfiles"]);
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("cancels a mission group made from a selection: each mission returns to where it was", async () => {
    useGroupsStore.setState({ groups: [group("g1")] });
    seed([ws("w1"), ws("w2", "g1"), ws("w3")]);
    mockIpc.createGroup.mockResolvedValue(group("made", { name: NEW_GROUP_NAME, sortOrder: 1 }));
    await createMissionGroup("p1", ["w1", "w2"]);
    expect([groupOf("w1"), groupOf("w2")]).toEqual(["made", "made"]);

    expect(await cancelNewGroup("made")).toBe(true);

    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("made");
    expect([groupOf("w1"), groupOf("w2"), groupOf("w3")]).toEqual([null, "g1", null]);
    expect(mockIpc.setItemGroup).toHaveBeenCalledTimes(1);
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("workspace", "w2", "g1");
  });

  it("once the first name is in, Escape is a rename's Escape again", async () => {
    seed([ws("w1")]);
    mockIpc.createGroup.mockResolvedValue(group("made", { name: NEW_GROUP_NAME }));
    await createMissionGroup("p1", "w1");
    useRailGroupUi.getState().stopRename(); // Enter or blur
    useRailGroupUi.getState().startRename("made"); // Rename… later

    expect(await cancelNewGroup("made")).toBe(false);
    expect(mockIpc.deleteGroup).not.toHaveBeenCalled();
    expect(groupOf("w1")).toBe("made");
  });

  it("an empty group from the project menu is not undone by Escape", async () => {
    mockIpc.createGroup.mockResolvedValue(group("made", { name: NEW_GROUP_NAME }));
    await createMissionGroup("p1");
    expect(await cancelNewGroup("made")).toBe(false);
    expect(mockIpc.deleteGroup).not.toHaveBeenCalled();
  });
});

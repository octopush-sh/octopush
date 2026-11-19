import { describe, it, expect } from "vitest";
import {
  filterRailItems,
  flattenTop,
  layoutMissions,
  layoutProjects,
  missionGroupOwners,
  missionGroupsOf,
  ownGroupId,
  projectGroupsOf,
  resolveRailDrop,
  resolveTopDrop,
  resolveTopDropWithCue,
  sectionByProject,
  sectionDragId,
  sectionHeadId,
  stepInRail,
  TOP_LOOSE_ID,
  type RailItem,
  type RailProject,
  type RailTopItem,
} from "./railGroups";
import type { Group, Workspace } from "./types";

function ws(id: string, groupId: string | null = null): Workspace {
  return {
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
  };
}

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

/** A layout as one readable line: `a [g: b c] d`. */
const read = (items: RailItem[]) =>
  items
    .map((i) => (i.kind === "mission" ? i.workspace.id : `[${i.group.id}: ${i.visible.map((w) => w.id).join(" ")}]`))
    .join(" ");

describe("missionGroupsOf", () => {
  it("keeps one project's workspace groups, in sortOrder then age", () => {
    const groups = [
      group("late", { sortOrder: 1, createdAt: "2026-02-01T00:00:00Z" }),
      group("early", { sortOrder: 1, createdAt: "2026-01-01T00:00:00Z" }),
      group("first", { sortOrder: 0 }),
      group("elsewhere", { projectId: "p2" }),
      group("section", { scope: "project", projectId: null }),
    ];
    expect(missionGroupsOf(groups, "p1").map((g) => g.id)).toEqual(["first", "early", "late"]);
  });
});

describe("ownGroupId", () => {
  const owners = missionGroupOwners([
    group("mine"),
    group("theirs", { projectId: "p2" }),
    group("section", { scope: "project", projectId: null }),
  ]);

  it("maps mission groups to their projects, and nothing else", () => {
    expect([...owners]).toEqual([
      ["mine", "p1"],
      ["theirs", "p2"],
    ]);
  });

  it("is the group only when the group is the workspace's own project's", () => {
    expect(ownGroupId(ws("a", "mine"), "p1", owners)).toBe("mine");
    expect(ownGroupId(ws("a", "theirs"), "p1", owners)).toBeNull();
    expect(ownGroupId(ws("a", "gone"), "p1", owners)).toBeNull();
    expect(ownGroupId(ws("a", "section"), "p1", owners)).toBeNull();
    expect(ownGroupId(ws("a"), "p1", owners)).toBeNull();
    expect(ownGroupId(undefined, "p1", owners)).toBeNull();
  });

  it("agrees with the layout about who is a member", () => {
    const rows = [ws("a", "mine"), ws("b", "theirs"), ws("c")];
    const members = layoutMissions(rows, missionGroupsOf([group("mine"), group("theirs", { projectId: "p2" })], "p1"))
      .flatMap((i) => (i.kind === "group" ? i.members.map((w) => w.id) : []));
    expect(members).toEqual(rows.filter((w) => ownGroupId(w, "p1", owners)).map((w) => w.id));
  });
});

describe("layoutMissions", () => {
  it("is the plain list when the project has no groups", () => {
    expect(read(layoutMissions([ws("a"), ws("b")], []))).toBe("a b");
  });

  it("puts a group where its first member sits and keeps the loose missions in order", () => {
    const rows = [ws("a"), ws("b", "g"), ws("c"), ws("d", "g"), ws("e")];
    expect(read(layoutMissions(rows, [group("g")]))).toBe("a [g: b d] c e");
  });

  it("returns a loose mission after a group to the outer level", () => {
    const items = layoutMissions([ws("a", "g"), ws("b", "g"), ws("c")], [group("g")]);
    expect(items.map((i) => i.kind)).toEqual(["group", "mission"]);
    expect(read(items)).toBe("[g: a b] c");
  });

  it("keeps the groups in their own order, pulling a later-anchored one up", () => {
    const rows = [ws("a"), ws("b", "second"), ws("c"), ws("d", "first"), ws("e")];
    const groups = [group("first", { sortOrder: 0 }), group("second", { sortOrder: 1 })];
    // `first` is ordered before `second`, whose member comes earlier: it is
    // pulled up to stand before it instead of the two swapping.
    expect(read(layoutMissions(rows, groups))).toBe("a [first: d] [second: b] c e");
  });

  it("puts an empty group last, or right before the group that follows it", () => {
    const rows = [ws("a"), ws("b", "full"), ws("c")];
    expect(read(layoutMissions(rows, [group("full"), group("empty", { sortOrder: 1 })]))).toBe(
      "a [full: b] c [empty: ]",
    );
    expect(read(layoutMissions(rows, [group("empty"), group("full", { sortOrder: 1 })]))).toBe(
      "a [empty: ] [full: b] c",
    );
  });

  it("treats a mission whose group is unknown as loose", () => {
    expect(read(layoutMissions([ws("a", "gone"), ws("b")], [group("g")]))).toBe("a b [g: ]");
  });
});

describe("filterRailItems", () => {
  const items = layoutMissions(
    [ws("alpha"), ws("fix-one", "g"), ws("fix-two", "g"), ws("report")],
    [group("g", { name: "Vulnerability fixes" })],
  );
  const by = (q: string) => (name: string) => name.toLowerCase().includes(q);

  it("a group-name hit keeps every member", () => {
    expect(read(filterRailItems(items, by("vulner")))).toBe("[g: fix-one fix-two]");
  });

  it("a member hit keeps the group with only the hits", () => {
    expect(read(filterRailItems(items, by("two")))).toBe("[g: fix-two]");
  });

  it("a group with no hit leaves, and loose missions are filtered by name", () => {
    expect(read(filterRailItems(items, by("report")))).toBe("report");
    expect(filterRailItems(items, by("zzz"))).toEqual([]);
  });

  it("does not change how many members the group has", () => {
    const [hit] = filterRailItems(items, by("two"));
    expect(hit.kind === "group" && hit.members.length).toBe(2);
  });
});

describe("resolveRailDrop", () => {
  const siblings = ["a", "b", "c"];

  it("a mission dropped on a group joins it", () => {
    expect(
      resolveRailDrop(
        { type: "mission", workspaceId: "w", projectId: "p1", groupId: null },
        { type: "group", groupId: "a", projectId: "p1" },
        siblings,
      ),
    ).toEqual({ kind: "move", workspaceId: "w", groupId: "a" });
  });

  it("a member dropped on the loose area leaves its group", () => {
    expect(
      resolveRailDrop(
        { type: "mission", workspaceId: "w", projectId: "p1", groupId: "a" },
        { type: "loose", projectId: "p1" },
        siblings,
      ),
    ).toEqual({ kind: "move", workspaceId: "w", groupId: null });
  });

  it("a drop that changes nothing is nothing", () => {
    const member = { type: "mission", workspaceId: "w", projectId: "p1", groupId: "a" } as const;
    expect(resolveRailDrop(member, { type: "group", groupId: "a", projectId: "p1" }, siblings)).toBeNull();
    const loose = { ...member, groupId: null };
    expect(resolveRailDrop(loose, { type: "loose", projectId: "p1" }, siblings)).toBeNull();
    const header = { type: "group", groupId: "a", projectId: "p1" } as const;
    expect(resolveRailDrop(header, { type: "group", groupId: "a", projectId: "p1" }, siblings)).toBeNull();
    expect(resolveRailDrop(header, { type: "loose", projectId: "p1" }, siblings)).toBeNull();
  });

  it("nothing crosses a project", () => {
    expect(
      resolveRailDrop(
        { type: "mission", workspaceId: "w", projectId: "p1", groupId: null },
        { type: "group", groupId: "x", projectId: "p2" },
        siblings,
      ),
    ).toBeNull();
  });

  it("a header dropped on a sibling takes its place, and the order is complete", () => {
    const header = { type: "group", groupId: "c", projectId: "p1" } as const;
    expect(resolveRailDrop(header, { type: "group", groupId: "a", projectId: "p1" }, siblings)).toEqual({
      kind: "reorder",
      ids: ["c", "a", "b"],
    });
    const down = { type: "group", groupId: "a", projectId: "p1" } as const;
    expect(resolveRailDrop(down, { type: "group", groupId: "c", projectId: "p1" }, siblings)).toEqual({
      kind: "reorder",
      ids: ["b", "c", "a"],
    });
  });
});

// ───────────────────────────── project groups ─────────────────────────────

const section = (id: string, over: Partial<Group> = {}) => group(id, { scope: "project", projectId: null, ...over });
const proj = (id: string, groupId: string | null = null): RailProject => ({ id, groupId });

/** A top-level layout as one readable line: `a [g: b c] d`. */
const readTop = (items: RailTopItem[]) =>
  items
    .map((i) => (i.kind === "project" ? i.project.id : `[${i.group.id}: ${i.projects.map((p) => p.id).join(" ")}]`))
    .join(" ");

const CLIENT = section("client", { sortOrder: 0 });
const SIDE = section("side", { sortOrder: 1 });
/** pinned · [client: api web] · [side: cli] · dotfiles */
const RAIL = layoutProjects(
  [proj("pinned"), proj("api", "client"), proj("web", "client"), proj("cli", "side"), proj("dotfiles")],
  [CLIENT, SIDE],
);

describe("projectGroupsOf", () => {
  it("keeps the project groups, in sortOrder then age", () => {
    const groups = [
      section("late", { sortOrder: 1, createdAt: "2026-02-01T00:00:00Z" }),
      section("early", { sortOrder: 1, createdAt: "2026-01-01T00:00:00Z" }),
      group("folder"),
      section("first", { sortOrder: 0 }),
    ];
    expect(projectGroupsOf(groups).map((g) => g.id)).toEqual(["first", "early", "late"]);
  });
});

describe("layoutProjects", () => {
  it("is the plain list when there are no groups", () => {
    expect(readTop(layoutProjects([proj("a"), proj("b")], []))).toBe("a b");
  });

  it("stands a group where its first project stands and gathers the rest under it", () => {
    const items = layoutProjects(
      [proj("a"), proj("api", "client"), proj("b"), proj("web", "client"), proj("c")],
      [CLIENT],
    );
    // `web` sat after `b`; it is drawn in its group, and `b` keeps its place after it.
    expect(readTop(items)).toBe("a [client: api web] b c");
    expect(flattenTop(items)).toEqual(["a", "api", "web", "b", "c"]);
  });

  it("follows the projects, not the groups' own sortOrder", () => {
    // `side` is second by sortOrder, but its first project stands first.
    const items = layoutProjects([proj("cli", "side"), proj("api", "client")], [CLIENT, SIDE]);
    expect(readTop(items)).toBe("[side: cli] [client: api]");
  });

  it("a pinned project stays in its group and brings the group up with it", () => {
    // The rail's order arrives pinned-first: `web` is pinned, so it leads.
    const items = layoutProjects(
      [proj("web", "client"), proj("loose-pinned"), proj("a"), proj("api", "client"), proj("b")],
      [CLIENT],
    );
    expect(readTop(items)).toBe("[client: web api] loose-pinned a b");
  });

  it("pinning a project of one group moves no other group", () => {
    const items = layoutProjects(
      [proj("cli", "side"), proj("a"), proj("api", "client"), proj("tool", "side")],
      [CLIENT, SIDE],
    );
    expect(readTop(items)).toBe("[side: cli tool] a [client: api]");
  });

  it("puts empty groups last, in their own order", () => {
    const groups = projectGroupsOf([section("empty-b", { sortOrder: 3 }), CLIENT, SIDE]);
    const items = layoutProjects([proj("a"), proj("cli", "side")], groups);
    expect(readTop(items)).toBe("a [side: cli] [client: ] [empty-b: ]");
  });

  it("treats an unknown group, and a mission group's id, as no group", () => {
    const items = layoutProjects([proj("a", "gone"), proj("b", "folder")], [CLIENT]);
    expect(readTop(items)).toBe("a b [client: ]");
    expect(sectionByProject(items).get("a")).toBeNull();
  });
});

describe("resolveTopDrop", () => {
  it("a project dropped on a project of its own container takes its place", () => {
    expect(resolveTopDrop(RAIL, "dotfiles", "pinned")).toEqual({
      order: ["dotfiles", "pinned", "api", "web", "cli"],
    });
    expect(resolveTopDrop(RAIL, "api", "web")).toEqual({ order: ["pinned", "web", "api", "cli", "dotfiles"] });
  });

  it("with no groups it is the plain reorder the rail always had", () => {
    const plain = layoutProjects([proj("a"), proj("b"), proj("c")], []);
    expect(resolveTopDrop(plain, "c", "a")).toEqual({ order: ["c", "a", "b"] });
    expect(resolveTopDrop(plain, "a", "b")).toEqual({ order: ["b", "a", "c"] });
  });

  it("a project that joins a group always becomes its last project, whichever of its projects it was dropped on", () => {
    // On the first project, on the last, from below, from above: last every time.
    const fromBelow = { order: ["pinned", "api", "web", "dotfiles", "cli"], move: { projectId: "dotfiles", groupId: "client" } };
    expect(resolveTopDrop(RAIL, "dotfiles", "api")).toEqual(fromBelow);
    expect(resolveTopDrop(RAIL, "dotfiles", "web")).toEqual(fromBelow);
    expect(resolveTopDrop(RAIL, "dotfiles", sectionHeadId("client"))).toEqual(fromBelow);
    const fromAbove = { order: ["api", "web", "pinned", "cli", "dotfiles"], move: { projectId: "pinned", groupId: "client" } };
    expect(resolveTopDrop(RAIL, "pinned", "api")).toEqual(fromAbove);
    expect(resolveTopDrop(RAIL, "pinned", sectionHeadId("client"))).toEqual(fromAbove);
  });

  it("a project dropped on another group as a whole lands beside it, loose", () => {
    // A loose project steps over the group: after it from above, before it from below.
    expect(resolveTopDrop(RAIL, "pinned", sectionDragId("client"))).toEqual({
      order: ["api", "web", "pinned", "cli", "dotfiles"],
    });
    expect(resolveTopDrop(RAIL, "dotfiles", sectionDragId("client"))).toEqual({
      order: ["pinned", "dotfiles", "api", "web", "cli"],
    });
    // A group's project does the same, and leaves its group.
    expect(resolveTopDrop(RAIL, "cli", sectionDragId("client"))).toEqual({
      order: ["pinned", "cli", "api", "web", "dotfiles"],
      move: { projectId: "cli", groupId: null },
    });
    expect(resolveTopDrop(RAIL, "api", sectionDragId("side"))).toEqual({
      order: ["pinned", "web", "cli", "api", "dotfiles"],
      move: { projectId: "api", groupId: null },
    });
    // Its own group as a whole is no target.
    expect(resolveTopDrop(RAIL, "api", sectionDragId("client"))).toBeNull();
  });

  it("an order the pinned-first rule would undo is not a reorder", () => {
    // p (pinned, loose) · [client: api* web] with api pinned · x
    const rail = layoutProjects(
      [{ id: "p", pinned: true }, { id: "api", groupId: "client", pinned: true }, proj("web", "client"), proj("x")],
      [CLIENT],
    );
    // The group is up there because of its pinned project: it cannot go below x…
    expect(resolveTopDrop(rail, sectionDragId("client"), "x")).toBeNull();
    // …and x cannot go above a pinned block.
    expect(resolveTopDrop(rail, "x", "p")).toBeNull();
    // Inside the group the unpinned project cannot lead.
    expect(resolveTopDrop(rail, "web", "api")).toBeNull();
    // Among the pinned blocks a reorder does show.
    expect(resolveTopDrop(rail, sectionDragId("client"), "p")).toEqual({ order: ["api", "web", "p", "x"] });
    // A move of membership still happens, with whatever order comes of it.
    expect(resolveTopDrop(rail, "x", sectionHeadId("client"))).toEqual({
      order: null,
      move: { projectId: "x", groupId: "client" },
    });
  });

  it("a group's project dropped on a loose project leaves its group", () => {
    expect(resolveTopDrop(RAIL, "web", "dotfiles")).toEqual({
      order: ["pinned", "api", "cli", "dotfiles", "web"],
      move: { projectId: "web", groupId: null },
    });
  });

  it("a project dropped on another group's project changes group", () => {
    expect(resolveTopDrop(RAIL, "web", "cli")).toEqual({
      order: ["pinned", "api", "cli", "web", "dotfiles"],
      move: { projectId: "web", groupId: "side" },
    });
  });

  it("a project dropped on a group's header joins it as its last project", () => {
    expect(resolveTopDrop(RAIL, "pinned", sectionHeadId("client"))).toEqual({
      order: ["api", "web", "pinned", "cli", "dotfiles"],
      move: { projectId: "pinned", groupId: "client" },
    });
    // Already right after the group's last project: only the membership changes.
    expect(resolveTopDrop(RAIL, "dotfiles", sectionHeadId("side"))).toEqual({
      order: null,
      move: { projectId: "dotfiles", groupId: "side" },
    });
    // On its own group's header: nothing.
    expect(resolveTopDrop(RAIL, "api", sectionHeadId("client"))).toBeNull();
  });

  it("a project dropped on an empty group's header joins it without a reorder", () => {
    const rail = layoutProjects([proj("a"), proj("b")], [CLIENT]);
    expect(resolveTopDrop(rail, "a", sectionHeadId("client"))).toEqual({
      order: null,
      move: { projectId: "a", groupId: "client" },
    });
  });

  it("a group moves as one unit, onto a loose project or onto another group", () => {
    expect(resolveTopDrop(RAIL, sectionDragId("side"), "pinned")).toEqual({
      order: ["cli", "pinned", "api", "web", "dotfiles"],
    });
    expect(resolveTopDrop(RAIL, sectionDragId("client"), sectionDragId("side"))).toEqual({
      order: ["pinned", "cli", "api", "web", "dotfiles"],
    });
    // Whatever part of the other group was hit, the whole group is the target.
    expect(resolveTopDrop(RAIL, sectionDragId("client"), "cli")).toEqual({
      order: ["pinned", "cli", "api", "web", "dotfiles"],
    });
    expect(resolveTopDrop(RAIL, sectionDragId("client"), sectionHeadId("side"))).toEqual({
      order: ["pinned", "cli", "api", "web", "dotfiles"],
    });
  });

  it("a project dropped on the ungrouped area leaves its group and goes last", () => {
    expect(resolveTopDrop(RAIL, "api", TOP_LOOSE_ID)).toEqual({
      order: ["pinned", "web", "cli", "dotfiles", "api"],
      move: { projectId: "api", groupId: null },
    });
    // The rail's last project is in a group: it leaves, and the order stands.
    const allGrouped = layoutProjects([proj("api", "client"), proj("web", "client")], [CLIENT]);
    expect(resolveTopDrop(allGrouped, "web", TOP_LOOSE_ID)).toEqual({
      order: null,
      move: { projectId: "web", groupId: null },
    });
  });

  it("a loose project or a group dropped on the ungrouped area only goes last", () => {
    expect(resolveTopDrop(RAIL, "pinned", TOP_LOOSE_ID)).toEqual({
      order: ["api", "web", "cli", "dotfiles", "pinned"],
    });
    expect(resolveTopDrop(RAIL, "dotfiles", TOP_LOOSE_ID)).toBeNull();
    expect(resolveTopDrop(RAIL, sectionDragId("client"), TOP_LOOSE_ID)).toEqual({
      order: ["pinned", "cli", "dotfiles", "api", "web"],
    });
  });

  it("means nothing on itself, on its own projects, or for an id it does not know", () => {
    expect(resolveTopDrop(RAIL, "api", "api")).toBeNull();
    expect(resolveTopDrop(RAIL, sectionDragId("client"), "api")).toBeNull();
    expect(resolveTopDrop(RAIL, "ghost", "api")).toBeNull();
    expect(resolveTopDrop(RAIL, "api", "ghost")).toBeNull();
    expect(resolveTopDrop(RAIL, "pinned", sectionDragId("ghost"))).toBeNull();
  });

  it("an empty group has no place to move to", () => {
    const rail = layoutProjects([proj("a"), proj("b")], [CLIENT]);
    expect(resolveTopDrop(rail, sectionDragId("client"), "a")).toBeNull();
  });
});

describe("stepInRail", () => {
  it("a project in a group steps among its group's projects and stops at the ends", () => {
    expect(stepInRail(RAIL, "web", -1)).toEqual(["pinned", "web", "api", "cli", "dotfiles"]);
    expect(stepInRail(RAIL, "api", 1)).toEqual(["pinned", "web", "api", "cli", "dotfiles"]);
    expect(stepInRail(RAIL, "api", -1)).toBeNull();
    expect(stepInRail(RAIL, "web", 1)).toBeNull();
    expect(stepInRail(RAIL, "cli", 1)).toBeNull();
  });

  it("a loose project steps over a whole group", () => {
    expect(stepInRail(RAIL, "pinned", 1)).toEqual(["api", "web", "pinned", "cli", "dotfiles"]);
    expect(stepInRail(RAIL, "dotfiles", -1)).toEqual(["pinned", "api", "web", "dotfiles", "cli"]);
    expect(stepInRail(RAIL, "pinned", -1)).toBeNull();
    expect(stepInRail(RAIL, "dotfiles", 1)).toBeNull();
  });

  it("a group steps as one unit", () => {
    expect(stepInRail(RAIL, sectionDragId("client"), -1)).toEqual(["api", "web", "pinned", "cli", "dotfiles"]);
    expect(stepInRail(RAIL, sectionDragId("client"), 1)).toEqual(["pinned", "cli", "api", "web", "dotfiles"]);
    expect(stepInRail(RAIL, sectionDragId("side"), 1)).toEqual(["pinned", "api", "web", "dotfiles", "cli"]);
  });

  it("empty groups are not a step, and have none", () => {
    const rail = layoutProjects([proj("a"), proj("b")], [CLIENT]);
    expect(stepInRail(rail, "b", 1)).toBeNull();
    expect(stepInRail(rail, sectionDragId("client"), -1)).toBeNull();
  });

  it("offers no step the pinned-first rule would undo", () => {
    // p (pinned, loose) · [client: api* web] with api pinned · x · y
    const rail = layoutProjects(
      [
        { id: "p", pinned: true },
        { id: "api", groupId: "client", pinned: true },
        proj("web", "client"),
        proj("x"),
        proj("y"),
      ],
      [CLIENT],
    );
    // The group raised by its pinned project has no way down past x, only up.
    expect(stepInRail(rail, sectionDragId("client"), 1)).toBeNull();
    expect(stepInRail(rail, sectionDragId("client"), -1)).toEqual(["api", "web", "p", "x", "y"]);
    // An unpinned project has no way above a pinned block, and a pinned one none below.
    expect(stepInRail(rail, "x", -1)).toBeNull();
    expect(stepInRail(rail, "p", 1)).toEqual(["api", "web", "p", "x", "y"]);
    expect(stepInRail(rail, "x", 1)).toEqual(["p", "api", "web", "y", "x"]);
    // Inside the group: the pinned project leads, whatever is stored.
    expect(stepInRail(rail, "web", -1)).toBeNull();
    expect(stepInRail(rail, "api", 1)).toBeNull();
    // Two loose projects, one pinned: neither can pass the other.
    const two = layoutProjects([{ id: "a", pinned: true }, proj("b")], []);
    expect(stepInRail(two, "a", 1)).toBeNull();
    expect(stepInRail(two, "b", -1)).toBeNull();
  });

  it("with no groups it is the neighbour swap the menu always did", () => {
    const plain = layoutProjects([proj("a"), proj("b"), proj("c")], []);
    expect(stepInRail(plain, "b", -1)).toEqual(["b", "a", "c"]);
    expect(stepInRail(plain, "b", 1)).toEqual(["a", "c", "b"]);
  });
});

describe("resolveTopDropWithCue: what the dragged block says, from the drop's own resolution", () => {
  // pinned · [client: api web] · [side: cli] · dotfiles, with names to show.
  const named = layoutProjects(
    [proj("pinned"), proj("api", "client"), proj("web", "client"), proj("cli", "side"), proj("dotfiles")],
    [section("client", { name: "Client work", sortOrder: 0 }), section("side", { name: "Side projects", sortOrder: 1 })],
  );
  const cue = (active: string, over: string | null) => resolveTopDropWithCue(named, active, over).cue;

  it("joining a group: Into that group", () => {
    expect(cue("dotfiles", sectionHeadId("client"))).toEqual({ kind: "into", groupId: "client", name: "Client work" });
    expect(cue("pinned", "web")).toEqual({ kind: "into", groupId: "client", name: "Client work" });
    // From one group to another: into the new one.
    expect(cue("api", sectionHeadId("side"))).toEqual({ kind: "into", groupId: "side", name: "Side projects" });
  });

  it("leaving its group: Out of the group it is in", () => {
    expect(cue("web", "dotfiles")).toEqual({ kind: "out", groupId: "client", name: "Client work" });
    expect(cue("cli", TOP_LOOSE_ID)).toEqual({ kind: "out", groupId: "side", name: "Side projects" });
    expect(cue("api", sectionDragId("side"))).toEqual({ kind: "out", groupId: "client", name: "Client work" });
  });

  it("a reorder only, or nothing at all: no cue", () => {
    expect(cue("web", "api")).toBeNull(); // same group
    expect(cue("dotfiles", "pinned")).toBeNull(); // loose to loose
    expect(cue("dotfiles", TOP_LOOSE_ID)).toBeNull(); // already last and loose
    expect(cue("api", sectionHeadId("client"))).toBeNull(); // its own header
    expect(cue("dotfiles", null)).toBeNull(); // over nothing
  });

  it("a group dragged as a whole never has a cue", () => {
    expect(cue(sectionDragId("side"), "pinned")).toBeNull();
    expect(cue(sectionDragId("client"), TOP_LOOSE_ID)).toBeNull();
  });

  it("its action is the drop's, call for call", () => {
    const pairs: Array<[string, string]> = [
      ["dotfiles", sectionHeadId("client")],
      ["web", "dotfiles"],
      ["web", "api"],
      ["cli", TOP_LOOSE_ID],
      [sectionDragId("side"), "pinned"],
      ["api", sectionDragId("side")],
    ];
    for (const [active, over] of pairs) {
      const { action, cue: said } = resolveTopDropWithCue(named, active, over);
      expect(action).toEqual(resolveTopDrop(named, active, over));
      // The cue says exactly what the action does to membership.
      if (!action?.move) expect(said).toBeNull();
      else if (action.move.groupId) expect(said).toMatchObject({ kind: "into", groupId: action.move.groupId });
      else expect(said?.kind).toBe("out");
    }
  });
});

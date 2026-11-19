import { describe, it, expect } from "vitest";
import {
  filterRailItems,
  layoutMissions,
  missionGroupOwners,
  missionGroupsOf,
  ownGroupId,
  resolveRailDrop,
  type RailItem,
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

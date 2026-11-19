import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DroppableContainer, UniqueIdentifier } from "@dnd-kit/core";

const sortableGetter = vi.hoisted(() => vi.fn());
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  sortableKeyboardCoordinates: sortableGetter,
}));

const { projectKeyboardCoordinates, railCollisions, railSubjectOf, railTargetOf } = await import("./railDnd");

/** dnd-kit's own container map is not exported; this has the one method the
 *  sortable getter calls on it besides Map's. */
class Containers extends Map<UniqueIdentifier, DroppableContainer> {
  getEnabled() {
    return [...this.values()].filter((c) => !c.disabled);
  }
}

const rect = (top: number, height: number) => ({
  top,
  left: 0,
  width: 280,
  height,
  bottom: top + height,
  right: 280,
});

function container(id: string, data: unknown, at = rect(0, 10)): DroppableContainer {
  return {
    id,
    key: id,
    data: { current: data },
    disabled: false,
    node: { current: null },
    rect: { current: at },
  } as unknown as DroppableContainer;
}

const PROJECT_A = container("p1", { sortable: { index: 0 } }, rect(0, 300));
const PROJECT_B = container("p2", { sortable: { index: 1 } }, rect(312, 100));
const LOOSE_A = container("loose:p1", { type: "loose", projectId: "p1" }, rect(28, 270));
const GROUP_A = container("group:g1", { type: "group", groupId: "g1", projectId: "p1" }, rect(60, 100));
const GROUP_B = container("group:g9", { type: "group", groupId: "g9", projectId: "p2" }, rect(340, 60));
const ALL = [PROJECT_A, LOOSE_A, GROUP_A, PROJECT_B, GROUP_B];

beforeEach(() => sortableGetter.mockReset());

describe("railSubjectOf / railTargetOf", () => {
  it("tell the rail's own drags and targets from the sortable list's", () => {
    expect(railSubjectOf({ type: "mission", workspaceId: "w", projectId: "p1", groupId: null })?.type).toBe("mission");
    expect(railSubjectOf({ type: "group", groupId: "g1", projectId: "p1" })?.type).toBe("group");
    expect(railSubjectOf({ sortable: { index: 0 } })).toBeNull();
    expect(railSubjectOf(undefined)).toBeNull();
    expect(railTargetOf({ type: "loose", projectId: "p1" })?.type).toBe("loose");
    expect(railTargetOf({ sortable: { index: 0 } })).toBeNull();
  });
});

describe("projectKeyboardCoordinates", () => {
  it("offers the sortable getter the projects only, in dnd-kit's own map type", () => {
    sortableGetter.mockReturnValue({ x: 1, y: 2 });
    const all = new Containers(ALL.map((c) => [c.id, c]));
    const context = { droppableContainers: all, over: null, marker: "kept" };
    const event = new KeyboardEvent("keydown", { code: "ArrowDown" });
    const args = { active: "p1", currentCoordinates: { x: 0, y: 0 }, context };

    const out = projectKeyboardCoordinates(event, args as unknown as Parameters<typeof projectKeyboardCoordinates>[1]);

    expect(out).toEqual({ x: 1, y: 2 });
    const [passedEvent, passed] = sortableGetter.mock.calls[0];
    expect(passedEvent).toBe(event);
    const offered = passed.context.droppableContainers as Containers;
    expect(offered).toBeInstanceOf(Containers);
    expect([...offered.keys()]).toEqual(["p1", "p2"]);
    expect(offered.getEnabled().map((c) => c.id)).toEqual(["p1", "p2"]);
    // Nothing else about the drag is touched, and the caller's map is intact.
    expect(passed.context.marker).toBe("kept");
    expect(passed.currentCoordinates).toEqual({ x: 0, y: 0 });
    expect([...all.keys()]).toHaveLength(ALL.length);
  });
});

describe("railCollisions", () => {
  const rects = new Map(ALL.map((c) => [c.id, c.rect.current!]));
  const detect = (data: unknown, collisionRect: ReturnType<typeof rect>, pointer: { x: number; y: number } | null) =>
    railCollisions({
      active: { id: "active", data: { current: data }, rect: { current: { initial: null, translated: null } } },
      collisionRect,
      droppableRects: rects,
      droppableContainers: ALL,
      pointerCoordinates: pointer,
    } as unknown as Parameters<typeof railCollisions>[0]).map((c) => c.id);

  it("a project only meets projects, however close a group's target is", () => {
    // Dragged right over p1's group: the nearest project still wins.
    expect(detect({ sortable: { index: 1 } }, rect(70, 100), null)[0]).toBe("p1");
    expect(detect({ sortable: { index: 0 } }, rect(330, 60), null)).toEqual(["p2", "p1"]);
  });

  it("a mission over a group lands on the group, not on the loose area around it", () => {
    const mission = { type: "mission", workspaceId: "w", projectId: "p1", groupId: null };
    expect(detect(mission, rect(0, 0), { x: 50, y: 80 })).toEqual(["group:g1"]);
  });

  it("a mission over the rest of its project lands on the loose area", () => {
    const member = { type: "mission", workspaceId: "w", projectId: "p1", groupId: "g1" };
    expect(detect(member, rect(0, 0), { x: 50, y: 200 })).toEqual(["loose:p1"]);
  });

  it("a mission never meets another project's group, nor a project", () => {
    const mission = { type: "mission", workspaceId: "w", projectId: "p1", groupId: null };
    expect(detect(mission, rect(0, 0), { x: 50, y: 350 })).toEqual([]);
    expect(detect(mission, rect(0, 0), { x: 50, y: 10 })).toEqual([]);
  });

  it("a group header meets the groups of its own project", () => {
    const header = { type: "group", groupId: "g2", projectId: "p1" };
    expect(detect(header, rect(0, 0), { x: 50, y: 80 })).toEqual(["group:g1"]);
  });
});

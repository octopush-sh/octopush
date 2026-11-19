import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DroppableContainer, UniqueIdentifier } from "@dnd-kit/core";

const sortableGetter = vi.hoisted(() => vi.fn());
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  sortableKeyboardCoordinates: sortableGetter,
}));

const { blockShift, blockTransform, projectKeyboardCoordinates, railCollisions, railSubjectOf, railTargetOf } =
  await import("./railDnd");

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

describe("project groups (sections)", () => {
  // Rects as a real rail has them: a project's block is its 28px line plus a
  // 32px row per mission, a group's header is 26px, and a dragged block is
  // held by the grip on its line, about 14px below its top. So the centre of
  // a dragged two-mission project (124px with its margin) is 48px under the
  // pointer, and that of a tall one far more.
  //
  //   0   octopush      (loose, 96px)
  // 108   CLIENT WORK   group, open: header 115–141
  // 143     acme-api    (96px)
  // 251     acme-admin  (300px: eight missions)
  // 610   SIDE PROJECTS group, FOLDED: header 617–643, its projects out of sight
  // 656   dotfiles      (loose, 96px)
  // 760   the ungrouped area under the last block
  const project = (id: string, sectionId: string | null, at: ReturnType<typeof rect>) =>
    container(id, { type: "project", sectionId, sortable: { index: 0 } }, at);
  const section = (groupId: string, at: ReturnType<typeof rect>) =>
    container(`section:${groupId}`, { type: "section", groupId, sortable: { index: 0 } }, at);
  const head = (groupId: string, at: ReturnType<typeof rect>) =>
    container(`section-head:${groupId}`, { type: "section-head", groupId }, at);

  const OCTOPUSH = project("octopush", null, rect(0, 96));
  const CLIENT = section("client", rect(108, 500));
  const CLIENT_HEAD = head("client", rect(115, 26));
  const API = project("acme-api", "client", rect(143, 96));
  const ADMIN = project("acme-admin", "client", rect(251, 300));
  const SIDE = section("side", rect(610, 34));
  const SIDE_HEAD = head("side", rect(617, 26));
  const DOTFILES = project("dotfiles", null, rect(656, 96));
  const FOOT = container("top-loose", { type: "top-loose" }, rect(760, 300));
  // A mission group's target inside acme-api, to show a project never meets it.
  const FOLDER = container("group:g1", { type: "group", groupId: "g1", projectId: "acme-api" }, rect(171, 60));
  const RAIL = [OCTOPUSH, CLIENT, CLIENT_HEAD, API, ADMIN, SIDE, SIDE_HEAD, DOTFILES, FOOT, FOLDER];

  const detectIn = (containers: DroppableContainer[]) => {
    const rects = new Map(containers.map((c) => [c.id, c.rect.current!]));
    return (data: unknown, collisionRect: ReturnType<typeof rect>, pointer: { x: number; y: number } | null) =>
      railCollisions({
        active: { id: "active", data: { current: data }, rect: { current: { initial: null, translated: null } } },
        collisionRect,
        droppableRects: rects,
        droppableContainers: containers,
        pointerCoordinates: pointer,
      } as unknown as Parameters<typeof railCollisions>[0]).map((c) => c.id);
  };
  const detect = detectIn(RAIL);
  const dragged = (sectionId: string | null) => ({ type: "project", sectionId, sortable: { index: 0 } });
  /** A block of `height` held by its grip with the pointer at `y`. */
  const held = (y: number, height: number) => ({ block: rect(y - 14, height), pointer: { x: 250, y } });

  it("a project of two missions held over a FOLDED group's eyebrow lands on that eyebrow", () => {
    // acme-api from Client work, the pointer centred on Side projects'
    // eyebrow. The block's centre is 48px lower, 26px from dotfiles' centre
    // and 48px from the eyebrow's: by centre alone it would be dropped on
    // dotfiles and leave its group instead of joining this one.
    const { block, pointer } = held(630, 124);
    expect(detect(dragged("client"), block, pointer)).toEqual(["section-head:side"]);
  });

  it("so does a pinned loose project, and one of eight missions", () => {
    const small = held(630, 124);
    expect(detect(dragged(null), small.block, small.pointer)).toEqual(["section-head:side"]);
    // 300px tall: its centre is 136px under the pointer, deep in the ungrouped area's neighbourhood.
    const tall = held(630, 300);
    expect(detect(dragged("client"), tall.block, tall.pointer)).toEqual(["section-head:side"]);
  });

  it("an open group's eyebrow wins over the project under the block's centre", () => {
    // dotfiles with the pointer on Client work's eyebrow: its centre is over
    // acme-api (15px from that project's centre, 48px from the eyebrow's).
    const { block, pointer } = held(128, 124);
    expect(detect(dragged(null), block, pointer)).toEqual(["section-head:client"]);
  });

  it("anywhere on another group means that group's header: joining has one landing place", () => {
    // Over acme-api's rows, over acme-admin's, at the group's foot.
    for (const y of [200, 400, 600]) {
      const { block, pointer } = held(y, 96);
      expect(detect(dragged(null), block, pointer)).toEqual(["section-head:client"]);
      expect(detect(dragged("side"), block, pointer)).toEqual(["section-head:client"]);
    }
  });

  it("on its own group's eyebrow it meets that header alone, where a drop does nothing", () => {
    // Side projects open, Client work folded: notebook-cli dragged onto Client
    // work's eyebrow, with its own group's header close by.
    const client = section("client", rect(108, 34));
    const clientHead = head("client", rect(115, 26));
    const side = section("side", rect(144, 300));
    const sideHead = head("side", rect(151, 26));
    const cli = project("notebook-cli", "side", rect(179, 96));
    const tool = project("notebook-tool", "side", rect(287, 96));
    const detectFolded = detectIn([OCTOPUSH, client, clientHead, side, sideHead, cli, tool]);
    const onto = held(128, 124);
    expect(detectFolded(dragged("side"), onto.block, onto.pointer)).toEqual(["section-head:client"]);
    // Held over its own eyebrow instead: not the slot nearest the block's centre.
    const home = held(164, 124);
    expect(detectFolded(dragged("side"), home.block, home.pointer)).toEqual(["section-head:side"]);
    // Below the eyebrow, over its own projects: a reorder among them.
    const below = held(300, 124);
    expect(detectFolded(dragged("side"), below.block, below.pointer)[0]).toBe("notebook-tool");
  });

  it("over its own group a project meets that group's projects only, by the block's centre", () => {
    // acme-admin dragged up inside Client work: the nearest of its siblings.
    const { block, pointer } = held(160, 300);
    const met = detect(dragged("client"), block, pointer);
    expect(met.sort()).toEqual(["acme-admin", "acme-api"]);
    const up = held(150, 124);
    expect(detect(dragged("client"), up.block, up.pointer)[0]).toBe("acme-api");
  });

  it("on the ungrouped top level it meets the top-level blocks: loose projects and other groups as wholes", () => {
    // Between octopush and Client work (y 100): no group under the pointer.
    const loose = held(100, 124);
    const met = detect(dragged(null), loose.block, loose.pointer);
    expect(met.sort()).toEqual(["dotfiles", "octopush", "section:client", "section:side"]);
    // A group's own project out there leaves: its own group is no target, nor are its siblings.
    const out = held(700, 124);
    const left = detect(dragged("client"), out.block, out.pointer);
    expect(left[0]).toBe("dotfiles");
    expect(left).not.toContain("section:client");
    expect(left).not.toContain("acme-api");
    expect(left).not.toContain("group:g1");
  });

  it("the ungrouped area under the last block wins only while the pointer is over it", () => {
    const below = held(900, 124);
    expect(detect(dragged("client"), below.block, below.pointer)).toEqual(["top-loose"]);
    // The block's centre reaches the area before the pointer does: not yet.
    const near = held(740, 300);
    expect(detect(dragged("client"), near.block, near.pointer)).not.toContain("top-loose");
    // A group dragged there goes last too.
    expect(detect({ type: "section", groupId: "client", sortable: { index: 1 } }, rect(800, 500), { x: 250, y: 820 })).toEqual([
      "top-loose",
    ]);
    // A mission never meets it.
    expect(
      detect({ type: "mission", workspaceId: "w", projectId: "acme-api", groupId: null }, rect(0, 0), { x: 250, y: 900 }),
    ).toEqual([]);
  });

  it("a group meets only the top-level blocks: loose projects and other groups", () => {
    const unit = { type: "section", groupId: "side", sortable: { index: 3 } };
    expect(detect(unit, rect(300, 34), { x: 250, y: 310 }).sort()).toEqual(["dotfiles", "octopush", "section:client"].concat("section:side").sort());
    expect(detect(unit, rect(20, 34), { x: 250, y: 30 })[0]).toBe("octopush");
  });

  it("the keyboard has no pointer: the nearest project or header, never a group as a whole or the area", () => {
    const met = detect(dragged(null), rect(656, 96), null);
    expect(met[0]).toBe("dotfiles");
    expect(met.sort()).toEqual(["acme-admin", "acme-api", "dotfiles", "octopush", "section-head:client", "section-head:side"]);
    // Among its own group's projects: a reorder, by the nearest one.
    expect(detect(dragged("client"), rect(251, 300), null)[0]).toBe("acme-admin");
  });

  it("a keyboard step onto another group's project means that group's header: it joins last, not mid-group", () => {
    expect(detect(dragged(null), rect(143, 96), null)).toEqual(["section-head:client"]);
    expect(detect(dragged("side"), rect(251, 300), null)).toEqual(["section-head:client"]);
  });

  it("the keyboard steps a project among projects only, inside groups too", () => {
    sortableGetter.mockReturnValue({ x: 0, y: 0 });
    const all = new Containers(RAIL.map((c) => [c.id, c]));
    const args = { active: "octopush", currentCoordinates: { x: 0, y: 0 }, context: { droppableContainers: all, over: null } };
    projectKeyboardCoordinates(
      new KeyboardEvent("keydown", { code: "ArrowDown" }),
      args as unknown as Parameters<typeof projectKeyboardCoordinates>[1],
    );
    const offered = sortableGetter.mock.calls[0][1].context.droppableContainers as Containers;
    expect([...offered.keys()]).toEqual(["octopush", "acme-api", "acme-admin", "dotfiles"]);
  });
});

describe("blockShift / blockTransform: a dragged block is moved, never scaled", () => {
  it("keeps only the translation of what the sortable list hands over", () => {
    // dnd-kit scales a dragged item to what it is over: a group's header over a short project…
    const squashed = { x: 0, y: -437, scaleX: 1, scaleY: 0.4465 };
    expect(blockShift(squashed, true, { x: 0, y: -437 })).toEqual({ x: 0, y: -437 });
    expect(blockTransform(blockShift(squashed, true, null))).toBe("translate3d(0px, -437px, 0px)");
    // …and over a taller group.
    const stretched = { x: 3, y: 120.4, scaleX: 1, scaleY: 1.502 };
    expect(blockTransform(blockShift(stretched, true, null))).toBe("translate3d(3px, 120px, 0px)");
    expect(blockTransform(blockShift(stretched, true, null))).not.toMatch(/scale/);
  });

  it("makes room in the list for another block by translation alone", () => {
    const room = { x: 0, y: 96, scaleX: 1, scaleY: 0.32 };
    expect(blockTransform(blockShift(room, false, null))).toBe("translate3d(0px, 96px, 0px)");
  });

  it("follows the pointer by the drag's delta where the list hands over nothing", () => {
    expect(blockShift(null, true, { x: 4, y: -539 })).toEqual({ x: 4, y: -539 });
    expect(blockTransform(blockShift(null, true, { x: 4, y: -539 }))).toBe("translate3d(4px, -539px, 0px)");
  });

  it("is nothing at rest, and for a block that is not the one dragged", () => {
    expect(blockShift(null, false, null)).toBeNull();
    expect(blockShift(null, false, { x: 0, y: 50 })).toBeNull();
    expect(blockShift(null, true, null)).toBeNull();
    expect(blockTransform(null)).toBeUndefined();
  });
});

// The workspace rail's one DndContext serves four drags: a project (the
// sortable lists, by pointer or keyboard), a project group as one unit with
// its projects, a mission and a mission-group header (pointer only). These
// helpers keep each drag among its own targets. The rules a drop follows are
// in `railGroups.ts` (`resolveTopDrop` for the top level, `resolveRailDrop`
// inside a project).

import { useState } from "react";
import {
  closestCenter,
  pointerWithin,
  useDndMonitor,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Transform } from "@dnd-kit/utilities";
import type { RailDragSubject, RailDropTarget } from "./railGroups";

/** What a drag in the rail carries, read back from dnd-kit's `data`. Null for
 *  a project: the sortable list puts its own data there. */
export function railSubjectOf(data: unknown): RailDragSubject | null {
  const d = data as Partial<RailDragSubject> | undefined;
  return d?.type === "mission" || d?.type === "group" ? (d as RailDragSubject) : null;
}

/** The mission-group drop target a droppable stands for, or null for a
 *  project of the sortable list. */
export function railTargetOf(data: unknown): RailDropTarget | null {
  const d = data as Partial<RailDropTarget> | undefined;
  return d?.type === "group" || d?.type === "loose" ? (d as RailDropTarget) : null;
}

/** What a sortable of the rail's top level is, as its `data` says: a project
 *  (loose, or in the section `sectionId`), a section dragged as one unit, or
 *  a section's header as the "join this group" target. The sortable list adds
 *  its own `sortable` key beside these. */
export type RailTopData =
  | { type: "project"; sectionId: string | null }
  | { type: "section"; groupId: string }
  | { type: "section-head"; groupId: string }
  /** The ungrouped area under the rail's last block. */
  | { type: "top-loose" };

const topTypeOf = (data: unknown) => (data as { type?: unknown } | undefined)?.type;
const isSection = (container: DroppableContainer) => topTypeOf(container.data.current) === "section";
const isSectionHead = (container: DroppableContainer) =>
  topTypeOf(container.data.current) === "section-head";
const isTopLoose = (container: DroppableContainer) => topTypeOf(container.data.current) === "top-loose";
/** A project of the sortable lists: anything that is no mission-group target
 *  and no part of the top level's group furniture. */
const isProject = (container: DroppableContainer) =>
  railTargetOf(container.data.current) === null &&
  !isSection(container) &&
  !isSectionHead(container) &&
  !isTopLoose(container);
const isLooseProject = (container: DroppableContainer) =>
  isProject(container) && !(container.data.current as { sectionId?: string | null } | undefined)?.sectionId;

const groupIdOf = (container: DroppableContainer) =>
  (container.data.current as { groupId?: string } | undefined)?.groupId ?? null;
const sectionIdOf = (data: unknown) => (data as { sectionId?: string | null } | undefined)?.sectionId ?? null;

/** A drag's one target: `container`, whatever lies nearer. */
const only = (container: DroppableContainer) => [{ id: container.id, data: { droppableContainer: container, value: 0 } }];

/**
 * Where a dragged PROJECT lands. Its block can be hundreds of pixels tall and
 * is held by a grip at its top, so the block's centre says little about where
 * the user is pointing: the POINTER decides which container the project is
 * over, and only then does the block's centre pick a place inside it.
 *
 *  - Over another project group, anywhere on it (its eyebrow or its
 *    projects; folded, that is the eyebrow alone): that group's header, which
 *    means "join it, as its last project".
 *  - Over its own group: the nearest of that group's projects (a reorder).
 *  - Anywhere else, the ungrouped top level: the nearest top-level block, a
 *    loose project or another group as a whole. A group's project leaves its
 *    group for it.
 *
 * The keyboard has no pointer. Its steps are aimed at projects by
 * `projectKeyboardCoordinates`, so the nearest project wins there, with the
 * group headers kept as targets.
 */
function projectCollisions(args: Parameters<CollisionDetection>[0]) {
  const all = args.droppableContainers;
  const own = sectionIdOf(args.active.data.current);
  if (args.pointerCoordinates === null) {
    return closestCenter({ ...args, droppableContainers: all.filter((c) => isProject(c) || isSectionHead(c)) });
  }
  const others = all.filter((c) => isSection(c) && groupIdOf(c) !== own);
  const [over] = pointerWithin({ ...args, droppableContainers: others });
  if (over) {
    const groupId = groupIdOf(over.data?.droppableContainer as DroppableContainer);
    const head = all.find((c) => isSectionHead(c) && groupIdOf(c) === groupId);
    if (head) return only(head);
  }
  const mine = own === null ? undefined : all.find((c) => isSection(c) && groupIdOf(c) === own);
  if (mine && pointerWithin({ ...args, droppableContainers: [mine] }).length > 0) {
    return closestCenter({
      ...args,
      droppableContainers: all.filter((c) => isProject(c) && sectionIdOf(c.data.current) === own),
    });
  }
  return closestCenter({ ...args, droppableContainers: [...all.filter(isLooseProject), ...others] });
}

/**
 * Each drag only sees its own targets. A project follows `projectCollisions`.
 * A project group lands among the top-level blocks, which are the loose
 * projects and the other groups. Either lands on the ungrouped area under
 * the last block only while the pointer is over it (a wide, empty target
 * would otherwise never be the nearest centre, or always). A mission or a
 * mission-group header lands on what is under the pointer in its own project,
 * a group first and the project's loose area otherwise.
 */
export const railCollisions: CollisionDetection = (args) => {
  const subject = railSubjectOf(args.active.data.current);
  if (!subject) {
    const foot = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(isTopLoose) });
    if (foot.length > 0) return foot;
    if (topTypeOf(args.active.data.current) !== "section") return projectCollisions(args);
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => isSection(c) || isLooseProject(c)),
    });
  }
  const mine = args.droppableContainers.filter(
    (c) => railTargetOf(c.data.current)?.projectId === subject.projectId,
  );
  const hits = pointerWithin({ ...args, droppableContainers: mine });
  const onGroup = hits.filter((h) => railTargetOf(h.data?.droppableContainer?.data?.current)?.type === "group");
  return onGroup.length > 0 ? onGroup : hits;
};

/**
 * The keyboard's next stop while a project is reordered (the grip, Space,
 * then ↑/↓). dnd-kit's sortable getter steps to the nearest droppable in the
 * arrow's direction, and the mission groups' drop targets are droppables too:
 * unfiltered, ↓ would land on a group or a loose area, where a project cannot
 * be dropped, and the reorder would do nothing. Only projects are offered,
 * whichever section they sit in: stepping onto a project of another section
 * (or onto a loose one) and dropping there moves the project into that
 * container, as the pointer does. Sections, missions and mission-group
 * headers have no keyboard drag (their menus move them).
 */
export const projectKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const all = args.context.droppableContainers;
  // The same Map subclass dnd-kit hands us (it carries `getEnabled`).
  const Containers = all.constructor as new (
    entries: Iterable<[UniqueIdentifier, DroppableContainer]>,
  ) => typeof all;
  const projects = new Containers([...all].filter(([, container]) => isProject(container)));
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: { ...args.context, droppableContainers: projects },
  });
};

/** A displacement of a block of the rail's top level: a translation, never a
 *  scale. */
export interface BlockShift {
  x: number;
  y: number;
}

/**
 * How far a block of the rail's top level (a project, or a project group) is
 * shifted during a drag, as a pure rule.
 *
 *  - `sorted` is what its sortable list hands it: the room it makes for the
 *    dragged block, or, for the dragged block itself, the pointer's travel.
 *    Only the TRANSLATION is kept. dnd-kit also scales a dragged item to the
 *    size of whatever it is over (`scaleY` 0.45 over a short project, 1.5 over
 *    a tall group), which squashes or stretches the block and pulls it off
 *    the pointer; the rail's blocks keep their own size.
 *  - The list moves an item only while the drag is over an item of that same
 *    list. Over anything else (another group's header, the ungrouped area) it
 *    hands the dragged block nothing, and the block would snap back to where
 *    it started. The rail draws no drag overlay for projects (one would stop
 *    the list moving them at all), so there the block follows the pointer by
 *    the drag's own `delta`. Both are the same travel for the dragged block,
 *    so nothing jumps when the pointer crosses from one target to another.
 */
export function blockShift(
  sorted: Transform | null,
  isDragging: boolean,
  delta: BlockShift | null,
): BlockShift | null {
  if (sorted) return { x: sorted.x, y: sorted.y };
  return isDragging && delta ? { x: delta.x, y: delta.y } : null;
}

/** `blockShift` as the inline `transform` of the block: a translation only. */
export function blockTransform(shift: BlockShift | null): string | undefined {
  return shift ? `translate3d(${Math.round(shift.x)}px, ${Math.round(shift.y)}px, 0)` : undefined;
}

/**
 * The inline `transform` that keeps a block of the rail's top level where the
 * drag puts it (`blockShift`): moved by its sortable list when the list moves
 * it, and under the pointer otherwise.
 */
export function useFollowPointer(id: UniqueIdentifier, isDragging: boolean, sorted: Transform | null): string | undefined {
  const [delta, setDelta] = useState<BlockShift | null>(null);
  useDndMonitor({
    onDragMove: (event) => {
      if (event.active.id === id) setDelta(event.delta);
    },
    onDragEnd: () => setDelta(null),
    onDragCancel: () => setDelta(null),
  });
  return blockTransform(blockShift(sorted, isDragging, delta));
}

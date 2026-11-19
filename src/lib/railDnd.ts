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

/**
 * Each drag only sees its own targets. A project lands among projects (in
 * any section or none) and on section headers, never on a section as a
 * whole; a section lands among the top-level blocks, which are the loose
 * projects and the other sections. Either lands on the ungrouped area under
 * the last block only while the pointer is over it (a wide, empty target
 * would otherwise never be the nearest centre, or always). A mission or a
 * mission-group header lands
 * on what is under the pointer in its own project, a group first and the
 * project's loose area otherwise.
 */
export const railCollisions: CollisionDetection = (args) => {
  const subject = railSubjectOf(args.active.data.current);
  if (!subject) {
    const foot = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(isTopLoose) });
    if (foot.length > 0) return foot;
    const mine =
      topTypeOf(args.active.data.current) === "section"
        ? (c: DroppableContainer) => isSection(c) || isLooseProject(c)
        : (c: DroppableContainer) => isProject(c) || isSectionHead(c);
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(mine) });
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

/**
 * The transform that keeps a dragged block of the top level under the pointer
 * while it is over a target OUTSIDE its own sortable list.
 *
 * A sortable item is moved by its list only while the drag is over an item of
 * that same list. Over anything else (a project of another group, a group's
 * header, the ungrouped area) dnd-kit hands it no transform, and the dragged
 * block would snap back to where it started and sit there until the drop. The
 * rail draws no drag overlay for projects (one would stop the list moving
 * them at all), so the block follows the pointer by the drag's own delta
 * instead. `sorted` is the list's transform, which wins whenever it exists:
 * the two are the same displacement for the dragged block, so there is no
 * jump when the pointer crosses from one kind of target to the other.
 */
export function useFollowPointer(id: UniqueIdentifier, isDragging: boolean, sorted: Transform | null): Transform | null {
  const [delta, setDelta] = useState<{ x: number; y: number } | null>(null);
  useDndMonitor({
    onDragMove: (event) => {
      if (event.active.id === id) setDelta(event.delta);
    },
    onDragEnd: () => setDelta(null),
    onDragCancel: () => setDelta(null),
  });
  if (sorted) return sorted;
  return isDragging && delta ? { x: delta.x, y: delta.y, scaleX: 1, scaleY: 1 } : null;
}

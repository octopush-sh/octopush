// The workspace rail's one DndContext serves three drags: a project (the
// sortable list, by pointer or keyboard), a mission and a mission-group
// header (pointer only). These helpers keep each drag among its own targets.
// The rules a drop follows are in `railGroups.ts` (`resolveRailDrop`).

import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
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

const isProject = (container: DroppableContainer) => railTargetOf(container.data.current) === null;

/**
 * Each drag only sees its own targets: a project lands among projects; a
 * mission or a group header lands on what is under the pointer in its own
 * project, a group first and the project's loose area otherwise.
 */
export const railCollisions: CollisionDetection = (args) => {
  const subject = railSubjectOf(args.active.data.current);
  if (!subject) {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(isProject) });
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
 * be dropped, and the reorder would do nothing. Only projects are offered.
 * Missions and group headers have no keyboard drag (their menus move them).
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

// Groups in the workspace rail: the pure rules. A mission group is a folder
// inside one project. It holds that project's missions (workspaces), sits
// between the loose ones, and never changes their order. A project group is a
// section of the rail's top level and holds projects (second half of this
// file). The components draw what these functions decide (design-system §8,
// "Workspace rail").

import type { Group, Workspace } from "./types";

/** One line of a project's run: a loose mission, or a group with its members. */
export type RailItem =
  | { kind: "mission"; workspace: Workspace }
  | {
      kind: "group";
      group: Group;
      /** Every member, in rail order. Aggregates count these. */
      members: Workspace[];
      /** The members the rail shows: all of them, or a filter's hits. */
      visible: Workspace[];
    };

/** The `workspace` groups of one project, in their own order. */
export function missionGroupsOf(groups: readonly Group[], projectId: string): Group[] {
  return groups
    .filter((g) => g.scope === "workspace" && g.projectId === projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

/** Which project each mission group belongs to, by group id. */
export function missionGroupOwners(groups: readonly Group[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const g of groups) if (g.scope === "workspace" && g.projectId) owners.set(g.id, g.projectId);
  return owners;
}

/** The mission group a workspace of `projectId` really sits in: its `groupId`
 *  when that names a group OF THAT PROJECT, else null (a loose mission). The
 *  same test `layoutMissions` applies, for the code that has no layout at
 *  hand: a stale or foreign `groupId` must mean "loose" everywhere at once. */
export function ownGroupId(
  workspace: Pick<Workspace, "groupId"> | undefined,
  projectId: string,
  owners: ReadonlyMap<string, string>,
): string | null {
  const groupId = workspace?.groupId ?? null;
  return groupId !== null && owners.get(groupId) === projectId ? groupId : null;
}

/** The name of the mission group a workspace sits in, looked up across every
 *  loaded project, or null for a loose (or unloaded) one. Same rule as
 *  `ownGroupId`: only a group of the workspace's own project counts. For the
 *  surfaces outside the rail that name a mission's group (Mission Control's
 *  `group · workspace` atom). */
export function missionGroupNameOf(
  workspacesByProjectId: Record<string, readonly Pick<Workspace, "id" | "projectId" | "groupId">[]>,
  groups: readonly Group[],
  workspaceId: string,
): string | null {
  for (const list of Object.values(workspacesByProjectId)) {
    const ws = list.find((w) => w.id === workspaceId);
    if (!ws) continue;
    const g = ws.groupId ? groups.find((x) => x.id === ws.groupId) : undefined;
    return g && g.scope === "workspace" && g.projectId === ws.projectId ? g.name : null;
  }
  return null;
}

/**
 * Interleave a project's groups with its loose missions.
 *
 * Missions keep the order the rail already gives them (`workspaces`, oldest
 * first). A group sits where its first member sits; `groups` arrives in the
 * backend's `sortOrder`, which is the law between groups, so a group is pulled
 * up to the one that follows it rather than letting two groups swap. An empty
 * group has no member to stand by: it goes right before the next group, or
 * last. A mission whose `groupId` names no known group is a loose mission.
 */
export function layoutMissions(workspaces: readonly Workspace[], groups: readonly Group[]): RailItem[] {
  if (groups.length === 0) return workspaces.map((workspace) => ({ kind: "mission", workspace }));
  const known = new Set(groups.map((g) => g.id));
  const membersByGroup = new Map<string, Workspace[]>(groups.map((g) => [g.id, []]));
  const firstIndex = new Map<string, number>();
  workspaces.forEach((workspace, index) => {
    const groupId = workspace.groupId ?? null;
    if (groupId === null || !known.has(groupId)) return;
    membersByGroup.get(groupId)!.push(workspace);
    if (!firstIndex.has(groupId)) firstIndex.set(groupId, index);
  });
  // Where each group stands, right to left: never after the group that follows it.
  const position = new Array<number>(groups.length);
  let next = Infinity;
  for (let i = groups.length - 1; i >= 0; i--) {
    next = Math.min(firstIndex.get(groups[i].id) ?? Infinity, next);
    position[i] = next;
  }
  const items: RailItem[] = [];
  let g = 0;
  const emitGroupsUpTo = (index: number) => {
    for (; g < groups.length && position[g] <= index; g++) {
      const members = membersByGroup.get(groups[g].id)!;
      items.push({ kind: "group", group: groups[g], members, visible: members });
    }
  };
  workspaces.forEach((workspace, index) => {
    emitGroupsUpTo(index);
    const groupId = workspace.groupId ?? null;
    if (groupId === null || !known.has(groupId)) items.push({ kind: "mission", workspace });
  });
  emitGroupsUpTo(Infinity);
  return items;
}

/**
 * Apply the rail filter to a project's items. `matches` says whether a name
 * holds the query. A group-name hit keeps all its members, the same rule as a
 * project-name hit (which the caller handles by not filtering at all);
 * otherwise a group keeps its member hits and leaves when it has none.
 */
export function filterRailItems(items: readonly RailItem[], matches: (name: string) => boolean): RailItem[] {
  const out: RailItem[] = [];
  for (const item of items) {
    if (item.kind === "mission") {
      if (matches(item.workspace.name ?? "")) out.push(item);
      continue;
    }
    if (matches(item.group.name)) {
      out.push(item);
      continue;
    }
    const visible = item.members.filter((w) => matches(w.name ?? ""));
    if (visible.length > 0) out.push({ ...item, visible });
  }
  return out;
}

/**
 * Apply the rail's state filter (#963) to a project's items, after the text
 * filter: a mission stays when `keep` says so; a group keeps the members it
 * shows that pass, and leaves when none does (a group has no state of its
 * own, so its name never keeps it).
 */
export function filterRailMissions(items: readonly RailItem[], keep: (workspace: Workspace) => boolean): RailItem[] {
  const out: RailItem[] = [];
  for (const item of items) {
    if (item.kind === "mission") {
      if (keep(item.workspace)) out.push(item);
      continue;
    }
    const visible = item.visible.filter(keep);
    if (visible.length > 0) out.push({ ...item, visible });
  }
  return out;
}

// ───────────────────────────── drag and drop ─────────────────────────────

/** What is being dragged in the rail. */
export type RailDragSubject =
  | { type: "mission"; workspaceId: string; projectId: string; groupId: string | null }
  | { type: "group"; groupId: string; projectId: string };

/** Where it was dropped: on a group (its header or its run), or on the part of
 *  a project that belongs to no group. */
export type RailDropTarget =
  | { type: "group"; groupId: string; projectId: string }
  | { type: "loose"; projectId: string };

export type RailDropAction =
  | { kind: "move"; workspaceId: string; groupId: string | null }
  | { kind: "reorder"; ids: string[] };

/**
 * What a drop means, or null when it means nothing. A mission dropped on a
 * group joins it; dropped on its project's loose area it leaves its group. A
 * group dropped on a sibling takes that sibling's place (`siblingIds` is the
 * project's groups in order, and the result is the complete new order).
 * Nothing crosses a project.
 */
export function resolveRailDrop(
  subject: RailDragSubject,
  target: RailDropTarget,
  siblingIds: readonly string[],
): RailDropAction | null {
  if (subject.projectId !== target.projectId) return null;
  if (subject.type === "mission") {
    const groupId = target.type === "group" ? target.groupId : null;
    return groupId === subject.groupId ? null : { kind: "move", workspaceId: subject.workspaceId, groupId };
  }
  if (target.type !== "group" || target.groupId === subject.groupId) return null;
  const from = siblingIds.indexOf(subject.groupId);
  const to = siblingIds.indexOf(target.groupId);
  if (from < 0 || to < 0) return null;
  const ids = [...siblingIds];
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return { kind: "reorder", ids };
}

// ───────────────────────────── project groups ─────────────────────────────
//
// A project group is a section of the rail's top level: it holds projects.
// In the code it is a "section", because `ProjectGroup` already names a
// project with its missions; in the UI both scopes are a "group".

/** The `project` groups, in their own order. */
export function projectGroupsOf(groups: readonly Group[]): Group[] {
  return groups
    .filter((g) => g.scope === "project")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

/** What the top-level layout needs of a project. */
export interface RailProject {
  id: string;
  groupId?: string | null;
  /** Pinned projects are listed first whatever order is stored: a reorder
   *  that only swaps a pinned project with an unpinned one changes nothing. */
  pinned?: boolean;
}

/** One block of the rail's top level: a loose project, or a section with its
 *  projects (every member, in rail order). */
export type RailTopItem<P extends RailProject = RailProject> =
  | { kind: "project"; project: P }
  | { kind: "section"; group: Group; projects: P[] };

/**
 * Gather the projects into their sections.
 *
 * `projects` arrives in the rail's order, which this never changes: pinned
 * projects first, then the manual order. A section stands where its FIRST
 * project stands and holds its other projects under it, in that same order;
 * loose projects keep their place around it. So a pinned project stays in its
 * group, leads it, and brings the group up into the pinned run with it.
 *
 * Unlike mission groups, the sections' own `sortOrder` is not a law between
 * them: projects have a manual order, so a section's place always follows its
 * projects. It only orders the EMPTY sections, which have no project to stand
 * by and go last. A project whose `groupId` names no known section is loose.
 */
export function layoutProjects<P extends RailProject>(
  projects: readonly P[],
  sections: readonly Group[],
): RailTopItem<P>[] {
  if (sections.length === 0) return projects.map((project) => ({ kind: "project", project }));
  const byId = new Map(sections.map((g) => [g.id, g]));
  const members = new Map<string, P[]>(sections.map((g) => [g.id, []]));
  const sectionOf = (project: P) => {
    const groupId = project.groupId ?? null;
    return groupId !== null && byId.has(groupId) ? groupId : null;
  };
  for (const project of projects) {
    const groupId = sectionOf(project);
    if (groupId) members.get(groupId)!.push(project);
  }
  const items: RailTopItem<P>[] = [];
  const placed = new Set<string>();
  for (const project of projects) {
    const groupId = sectionOf(project);
    if (!groupId) {
      items.push({ kind: "project", project });
    } else if (!placed.has(groupId)) {
      placed.add(groupId);
      items.push({ kind: "section", group: byId.get(groupId)!, projects: members.get(groupId)! });
    }
  }
  for (const group of sections) {
    if (!placed.has(group.id)) items.push({ kind: "section", group, projects: [] });
  }
  return items;
}

const SECTION_DRAG = "section:";
const SECTION_HEAD = "section-head:";
/** The id a section is dragged by, as one unit with its projects. */
export const sectionDragId = (groupId: string) => `${SECTION_DRAG}${groupId}`;
/** The id of a section's header as a drop target ("join this group"). */
export const sectionHeadId = (groupId: string) => `${SECTION_HEAD}${groupId}`;
/** The id of the ungrouped area under the last block of the rail: a project
 *  dropped there leaves its group. */
export const TOP_LOOSE_ID = "top-loose";

const topItemId = (item: RailTopItem) =>
  item.kind === "project" ? item.project.id : sectionDragId(item.group.id);

/** Every project id, in the order the rail shows them. */
export function flattenTop(items: readonly RailTopItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "project" ? [item.project.id] : item.projects.map((p) => p.id),
  );
}

/** The section each project sits in (null: loose), by project id. */
export function sectionByProject(items: readonly RailTopItem[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const item of items) {
    if (item.kind === "project") out.set(item.project.id, null);
    else for (const p of item.projects) out.set(p.id, item.group.id);
  }
  return out;
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** What a drop at the rail's top level changes. */
export interface TopDropAction {
  /** Every project id in the new rail order; null when the order stands. */
  order: string[] | null;
  /** The project that changes group (`groupId` null: it leaves its group). */
  move?: { projectId: string; groupId: string | null };
}

/**
 * The rail's project order once `order` is stored: the backend lists pinned
 * projects first, then the stored order.
 */
function listedOrder(items: readonly RailTopItem[], order: readonly string[]): string[] {
  const pinned = new Set(
    items.flatMap((item) => (item.kind === "project" ? [item.project] : item.projects)).filter((p) => p.pinned).map((p) => p.id),
  );
  return [...order.filter((id) => pinned.has(id)), ...order.filter((id) => !pinned.has(id))];
}

/**
 * `order` when storing it would change what the rail shows, else null. A
 * reorder can be undone by the pinned-first rule before it is ever seen (a
 * group raised by a pinned project cannot go below an unpinned block, an
 * unpinned project cannot go above a pinned one): such an order is not worth
 * a write, and a menu must not offer the step that produces it.
 */
function visibleReorder(items: readonly RailTopItem[], order: string[]): string[] | null {
  const byId = new Map(
    items.flatMap((item) => (item.kind === "project" ? [item.project] : item.projects)).map((p) => [p.id, p] as const),
  );
  const sections = items.flatMap((item) => (item.kind === "section" ? [item.group] : []));
  const after = layoutProjects(
    listedOrder(items, order).map((id) => byId.get(id)!),
    sections,
  );
  return sameOrder(flattenTop(after), flattenTop(items)) ? null : order;
}

/**
 * What dropping `activeId` on `overId` means at the rail's top level, or null
 * when it means nothing. Ids are project ids, `sectionDragId`s,
 * `sectionHeadId`s and `TOP_LOOSE_ID`; `items` is the whole layout (no filter).
 *
 *  - A section moves as one unit: it takes the place of the top-level block
 *    it was dropped on (a loose project, or the section around the target).
 *  - A project that JOINS a section always becomes its last project, whether
 *    it was dropped on the section's header or on one of its projects (the
 *    pointer picks the header for any point of another section, see
 *    `railCollisions`; the keyboard can step onto a project of it).
 *  - A project dropped on a project of its own container takes its place.
 *  - A section's project dropped on the loose top level leaves its section:
 *    on a loose project it takes that project's place, on another section as
 *    a whole it lands beside it (before it when it came from below, after it
 *    when it came from above), as a loose project would.
 *  - Anything dropped on the ungrouped area under the rail's last block
 *    (`TOP_LOOSE_ID`) goes last; a project leaves its group for it.
 *
 * The order is the full project order to persist, so a section's projects
 * stay one run in the stored order too. An order the pinned-first rule would
 * undo is left out (`visibleReorder`).
 */
export function resolveTopDrop(
  items: readonly RailTopItem[],
  activeId: string,
  overId: string,
): TopDropAction | null {
  if (activeId === overId) return null;
  const flat = flattenTop(items);
  const sectionOf = sectionByProject(items);
  const headOf = overId.startsWith(SECTION_HEAD) ? overId.slice(SECTION_HEAD.length) : null;
  const toFoot = overId === TOP_LOOSE_ID;
  const changed = (order: string[]) => (sameOrder(order, flat) ? null : order);
  const sectionWith = (groupId: string) => {
    const found = items.find((item) => item.kind === "section" && item.group.id === groupId);
    return found?.kind === "section" ? found : null;
  };

  if (activeId.startsWith(SECTION_DRAG)) {
    const topIds = items.map(topItemId);
    const from = topIds.indexOf(activeId);
    if (from < 0) return null;
    const overSection = headOf ?? sectionOf.get(overId) ?? null;
    const to = toFoot ? items.length - 1 : topIds.indexOf(overSection ? sectionDragId(overSection) : overId);
    if (to < 0 || from === to) return null;
    const order = changed(flattenTop(moved(items, from, to)));
    const seen = order && visibleReorder(items, order);
    return seen ? { order: seen } : null;
  }

  if (!sectionOf.has(activeId)) return null;
  const mine = sectionOf.get(activeId) ?? null;
  const without = flat.filter((id) => id !== activeId);
  /** A pure reorder: nothing when the rail would look the same after it. */
  const reorder = (order: string[]): TopDropAction | null => {
    const seen = changed(order) && visibleReorder(items, order);
    return seen ? { order: seen } : null;
  };
  /** Out of its group (when it is in one) and to `order`. */
  const loose = (order: string[]): TopDropAction | null =>
    mine === null ? reorder(order) : { order: changed(order), move: { projectId: activeId, groupId: null } };

  if (toFoot) return loose([...without, activeId]);

  // Joining a section: its header, or any of its projects.
  const joins = headOf ?? (sectionOf.has(overId) ? (sectionOf.get(overId) ?? null) : null);
  if (joins !== null && joins !== mine) {
    const section = sectionWith(joins);
    if (!section) return null;
    const move = { projectId: activeId, groupId: joins };
    const last = section.projects[section.projects.length - 1];
    // An empty section stands where its first project will: nothing to reorder.
    if (!last) return { order: null, move };
    const order = [...without];
    order.splice(order.indexOf(last.id) + 1, 0, activeId);
    return { order: changed(order), move };
  }
  if (headOf !== null) return null; // its own section's header

  // Another section as a whole: beside it, at the top level.
  if (overId.startsWith(SECTION_DRAG)) {
    const section = sectionWith(overId.slice(SECTION_DRAG.length));
    if (!section || section.group.id === mine) return null;
    if (section.projects.length === 0) return loose([...without, activeId]);
    const first = section.projects[0].id;
    const last = section.projects[section.projects.length - 1].id;
    const fromAbove = flat.indexOf(activeId) < flat.indexOf(first);
    const order = [...without];
    order.splice(fromAbove ? order.indexOf(last) + 1 : order.indexOf(first), 0, activeId);
    return loose(order);
  }

  if (!sectionOf.has(overId)) return null;
  // A project of its own container (a reorder), or a loose one (it leaves).
  const order = moved(flat, flat.indexOf(activeId), flat.indexOf(overId));
  return (sectionOf.get(overId) ?? null) === mine ? reorder(order) : loose(order);
}

/** What a pending top-level drop would do to the dragged project's group,
 *  as the dragged block says it: join `groupId` ("Into …"), or leave it
 *  ("Out of …"). Null when the drop only reorders, or does nothing. */
export interface TopDropCue {
  kind: "into" | "out";
  /** The group joined, or the group left. */
  groupId: string;
  name: string;
}

/** A drop at the top level, resolved once: what it does (`resolveTopDrop`)
 *  and what the dragged block says about it (`TopDropCue`). The rail reads
 *  the cue while the drag is over a target and applies the action when it is
 *  dropped there, from this one call, so the two can never disagree. */
export interface ResolvedTopDrop {
  action: TopDropAction | null;
  cue: TopDropCue | null;
}

/**
 * Resolve dropping `activeId` on `overId` (null: over nothing) at the rail's
 * top level. A group dragged as a whole never changes membership, so it never
 * has a cue; nor does a project that only reorders.
 */
export function resolveTopDropWithCue(
  items: readonly RailTopItem[],
  activeId: string,
  overId: string | null,
): ResolvedTopDrop {
  const action = overId === null ? null : resolveTopDrop(items, activeId, overId);
  const move = action?.move;
  if (!move) return { action, cue: null };
  const groupId = move.groupId ?? sectionByProject(items).get(move.projectId) ?? null;
  const section = groupId
    ? items.find((item) => item.kind === "section" && item.group.id === groupId)
    : undefined;
  if (!groupId || section?.kind !== "section") return { action, cue: null };
  return {
    action,
    cue: { kind: move.groupId ? "into" : "out", groupId, name: section.group.name },
  };
}

/**
 * The project order after a one-step move from a menu ("Move up", "Move
 * down"), or null when there is nowhere to go. `id` is a project id or a
 * `sectionDragId`. A project in a section steps among that section's projects
 * and stops at its ends; a loose project and a section step over the next
 * top-level block as a whole. Empty sections are not a step: they stand last
 * and hold no project to step over. Neither is a step the pinned-first rule
 * would undo (`visibleReorder`): a menu offers only moves that show.
 */
export function stepInRail(items: readonly RailTopItem[], id: string, direction: -1 | 1): string[] | null {
  const flat = flattenTop(items);
  const section = sectionByProject(items).get(id) ?? null;
  if (section) {
    const run = items.find((item) => item.kind === "section" && item.group.id === section);
    if (!run || run.kind !== "section") return null;
    const ids = run.projects.map((p) => p.id);
    const at = ids.indexOf(id);
    const neighbour = ids[at + direction];
    if (!neighbour) return null;
    return visibleReorder(items, moved(flat, flat.indexOf(id), flat.indexOf(neighbour)));
  }
  const blocks = items.filter((item) => item.kind === "project" || item.projects.length > 0);
  const at = blocks.findIndex((item) => topItemId(item) === id);
  if (at < 0 || !blocks[at + direction]) return null;
  return visibleReorder(items, flattenTop(moved(blocks, at, at + direction)));
}

/**
 * The project groups' order after "Move up" / "Move down" on an EMPTY group,
 * or null when there is nowhere to go. Empty groups have no project to stand
 * by: they stand last, after every block with projects, in their own order
 * (`layoutProjects`). One steps over its neighbour in that run and stops at
 * its ends. The answer is every project group's id in the new `sortOrder`
 * (what `set_group_order` takes): the empty groups trade places, the others
 * keep theirs.
 */
export function stepEmptySection(items: readonly RailTopItem[], groupId: string, direction: -1 | 1): string[] | null {
  const sections = items.flatMap((item) => (item.kind === "section" ? [item] : []));
  const empty = sections.filter((s) => s.projects.length === 0).map((s) => s.group.id);
  const at = empty.indexOf(groupId);
  if (at < 0 || !empty[at + direction]) return null;
  const run = moved(empty, at, at + direction);
  const all = projectGroupsOf(sections.map((s) => s.group)).map((g) => g.id);
  let next = 0;
  return all.map((id) => (empty.includes(id) ? run[next++] : id));
}

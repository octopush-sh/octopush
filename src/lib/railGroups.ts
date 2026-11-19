// Mission groups in the workspace rail: the pure rules. A mission group is a
// folder inside one project. It holds that project's missions (workspaces),
// sits between the loose ones, and never changes their order. The components
// draw what these functions decide (design-system §8, "Workspace rail").

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

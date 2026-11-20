import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
import { useProjectStore } from "./projectStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useRailGroupUi } from "./railGroupUiStore";
import { beginMembershipChange } from "../lib/membershipGuard";
import type { Group, GroupScope, ProjectInfo, TintName, Workspace } from "../lib/types";

/** Rail groups: named, optionally tinted, one-level containers for projects
 *  (`project` scope) or for one project's workspaces (`workspace` scope).
 *
 *  This store holds the groups. Membership is the member's own `groupId`, on
 *  the rows `projectStore` and `workspaceStore` already hold, so the actions
 *  that change membership (`create`, `remove`, `moveItem`) patch those stores
 *  too. Every change but `create` is applied at once and rolled back if the
 *  backend refuses it; `create` waits for the backend, which mints the id and
 *  picks the position.
 *
 *  Two things keep a reload from undoing a change it could not have seen:
 *  `load` re-reads when a change started or settled while it was reading, and
 *  the membership changes go through `lib/membershipGuard.ts`, which the
 *  project and workspace loaders consult. */
interface GroupsState {
  /** Every group, sorted like the backend lists them (see `sortGroups`). */
  groups: Group[];
  loaded: boolean;
  /** Read the groups from the backend. Safe to call often: concurrent calls
   *  share one read, and a read that raced a change is thrown away and
   *  repeated instead of overwriting it. */
  load: () => Promise<void>;
  /** Create a group, optionally around existing items. Null when refused. */
  create: (input: {
    scope: GroupScope;
    /** Required for a `workspace` group; leave out for a `project` group. */
    projectId?: string | null;
    name: string;
    tint?: TintName | null;
    memberIds?: string[];
  }) => Promise<Group | null>;
  /** Rename. A blank name is ignored (resolves false, nothing is sent). */
  rename: (groupId: string, name: string) => Promise<boolean>;
  setTint: (groupId: string, tint: TintName | null) => Promise<boolean>;
  /** Persist the order of sibling groups: `ids` in their new order. The
   *  backend numbers exactly the ids it is sent, so siblings missing from
   *  `ids` are appended in their current order: it always gets the full run. */
  setOrder: (ids: string[]) => Promise<boolean>;
  /** Delete a group; its members stay, ungrouped. */
  remove: (groupId: string) => Promise<boolean>;
  /** Move a project or workspace into a group, or out of any (`null`). */
  moveItem: (kind: GroupScope, itemId: string, groupId: string | null) => Promise<boolean>;
  /** Move several items of one kind the same way, in one backend call: all
   *  of them or none, with one toast when refused. */
  moveItems: (kind: GroupScope, itemIds: readonly string[], groupId: string | null) => Promise<boolean>;
  /** Forget a project's workspace groups: the project was closed or deleted. */
  pruneProject: (projectId: string) => void;
}

/** The backend's listing order: project groups first, then workspace groups
 *  project by project, each run by `sortOrder` (ties: oldest first). */
export function sortGroups(groups: Group[]): Group[] {
  return [...groups].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      (a.projectId ?? "").localeCompare(b.projectId ?? "") ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

const isSibling = (a: Group, b: Group) => a.scope === b.scope && a.projectId === b.projectId;

function refused(title: string, e: unknown) {
  const body = (e instanceof Error ? e.message : String(e)).replace(/^other: /, "").split("\n")[0];
  pushToast({ level: "error", title, body });
}

/** Set `groupId` on the listed projects or workspaces, in every list that
 *  holds them. */
function patchMembership(kind: GroupScope, groupIdByItem: Map<string, string | null>) {
  if (groupIdByItem.size === 0) return;
  const patch = <T extends ProjectInfo | Workspace>(item: T): T =>
    groupIdByItem.has(item.id) ? { ...item, groupId: groupIdByItem.get(item.id) ?? null } : item;
  if (kind === "project") {
    useProjectStore.setState((s) => ({
      current: s.current ? patch(s.current) : s.current,
      recent: s.recent.map(patch),
      closed: s.closed.map(patch),
    }));
    return;
  }
  useWorkspaceStore.setState((s) => {
    const byProject: Record<string, Workspace[]> = {};
    for (const [projectId, list] of Object.entries(s.workspacesByProjectId)) {
      byProject[projectId] = list.map(patch);
    }
    return { workspaces: s.workspaces.map(patch), workspacesByProjectId: byProject };
  });
}

/** The loaded projects or workspaces, once each. */
function loadedItems(kind: GroupScope): Array<ProjectInfo | Workspace> {
  const byId = new Map<string, ProjectInfo | Workspace>();
  if (kind === "project") {
    const s = useProjectStore.getState();
    for (const p of [...s.recent, ...s.closed, ...(s.current ? [s.current] : [])]) byId.set(p.id, p);
  } else {
    const s = useWorkspaceStore.getState();
    for (const w of [...s.workspaces, ...Object.values(s.workspacesByProjectId).flat()]) byId.set(w.id, w);
  }
  return [...byId.values()];
}

const groupOf = (kind: GroupScope, itemId: string): string | null =>
  loadedItems(kind).find((item) => item.id === itemId)?.groupId ?? null;

/** Ids of the loaded items that sit in the group. */
const membersOf = (kind: GroupScope, groupId: string): string[] =>
  loadedItems(kind)
    .filter((item) => item.groupId === groupId)
    .map((item) => item.id);

const assign = (ids: string[], groupId: string | null) =>
  new Map(ids.map((id) => [id, groupId] as const));

// A group change in flight, for `load`: `epoch` moves when a change starts
// and when it settles, so a read that spans either is known to be stale.
let epoch = 0;
const changesInFlight = new Set<Promise<unknown>>();
function tracked<T>(request: () => Promise<T>): Promise<T> {
  epoch++;
  const settled = request().finally(() => {
    epoch++;
    changesInFlight.delete(settled);
  });
  changesInFlight.add(settled);
  return settled;
}

let reading: Promise<void> | null = null;
let readAgain = false;
/** How often one `load` re-reads before it leaves the optimistic state alone. */
const MAX_READS = 4;

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: [],
  loaded: false,

  load: () => {
    if (reading) {
      // Whoever asked wants rows at least as fresh as now.
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      try {
        for (let attempt = 0; attempt < MAX_READS; attempt++) {
          // A change still in flight may or may not be in the rows yet.
          if (changesInFlight.size > 0) await Promise.allSettled([...changesInFlight]);
          readAgain = false;
          const startedAt = epoch;
          const groups = await ipc.listGroups();
          if (startedAt !== epoch) continue;
          set({ groups: sortGroups(groups), loaded: true });
          // The list is the truth now: folds of groups that are gone go too.
          useRailGroupUi.getState().prune(new Set(groups.map((g) => g.id)));
          if (!readAgain) return;
        }
      } catch (e) {
        refused("Couldn't load groups", e);
      } finally {
        reading = null;
      }
    })();
    return reading;
  },

  create: async (input) => {
    try {
      const created = await tracked(() => ipc.createGroup(input));
      // The backend made room at the new group's position: its siblings from
      // there on moved down by one.
      set((s) => ({
        groups: sortGroups([
          ...s.groups
            .filter((g) => g.id !== created.id)
            .map((g) =>
              isSibling(g, created) && g.sortOrder >= created.sortOrder
                ? { ...g, sortOrder: g.sortOrder + 1 }
                : g,
            ),
          created,
        ]),
      }));
      const memberIds = input.memberIds ?? [];
      // The id exists only now, so the change settles as it is recorded: a
      // reload that began before this point still gets it laid over.
      beginMembershipChange(created.scope, memberIds, created.id).settle();
      patchMembership(created.scope, assign(memberIds, created.id));
      return created;
    } catch (e) {
      refused("Couldn't create the group", e);
      return null;
    }
  },

  rename: async (groupId, name) => {
    const trimmed = name.trim();
    const before = get().groups.find((g) => g.id === groupId);
    if (!trimmed || !before) return false;
    if (before.name === trimmed) return true;
    const withName = (value: string) =>
      set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name: value } : g)) }));
    withName(trimmed);
    try {
      await tracked(() => ipc.renameGroup(groupId, trimmed));
      return true;
    } catch (e) {
      // Leave a newer rename alone.
      if (get().groups.find((g) => g.id === groupId)?.name === trimmed) withName(before.name);
      refused("Couldn't rename the group", e);
      return false;
    }
  },

  setTint: async (groupId, tint) => {
    const before = get().groups.find((g) => g.id === groupId);
    if (!before) return false;
    if (before.tint === tint) return true;
    const withTint = (value: TintName | null) =>
      set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, tint: value } : g)) }));
    withTint(tint);
    try {
      await tracked(() => ipc.setGroupTint(groupId, tint));
      return true;
    } catch (e) {
      if (get().groups.find((g) => g.id === groupId)?.tint === tint) withTint(before.tint);
      refused("Couldn't change the group's tint", e);
      return false;
    }
  },

  setOrder: async (ids) => {
    const first = get().groups.find((g) => g.id === ids[0]);
    if (!first) return false;
    const siblings = get().groups.filter((g) => isSibling(g, first));
    const siblingIds = new Set(siblings.map((g) => g.id));
    const asked = ids.filter((id, index) => siblingIds.has(id) && ids.indexOf(id) === index);
    const full = [...asked, ...siblings.map((g) => g.id).filter((id) => !asked.includes(id))];
    if (full.every((id, index) => siblings[index].id === id)) return true;
    const before = new Map(siblings.map((g) => [g.id, g.sortOrder] as const));
    const mine = new Map(full.map((id, index) => [id, index] as const));
    const withOrder = (orderById: Map<string, number>) =>
      set((s) => ({
        groups: sortGroups(
          s.groups.map((g) =>
            orderById.has(g.id) ? { ...g, sortOrder: orderById.get(g.id) ?? g.sortOrder } : g,
          ),
        ),
      }));
    withOrder(mine);
    try {
      await tracked(() => ipc.setGroupOrder(full));
      return true;
    } catch (e) {
      // Leave a newer reorder alone: roll back only while every group still
      // sits where this call put it.
      const untouched = get()
        .groups.filter((g) => mine.has(g.id))
        .every((g) => g.sortOrder === mine.get(g.id));
      if (untouched) withOrder(before);
      refused("Couldn't reorder the groups", e);
      return false;
    }
  },

  remove: async (groupId) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return false;
    const members = membersOf(group.scope, groupId);
    set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
    const change = beginMembershipChange(group.scope, members, null);
    patchMembership(group.scope, assign(members, null));
    try {
      await tracked(() => ipc.deleteGroup(groupId));
      change.settle();
      return true;
    } catch (e) {
      change.drop();
      set((s) => ({
        groups: s.groups.some((g) => g.id === groupId) ? s.groups : sortGroups([...s.groups, group]),
      }));
      // Members that were moved elsewhere meanwhile stay where they went.
      patchMembership(
        group.scope,
        assign(members.filter((id) => groupOf(group.scope, id) === null), groupId),
      );
      refused("Couldn't remove the group", e);
      return false;
    }
  },

  moveItem: async (kind, itemId, groupId) => {
    const before = groupOf(kind, itemId);
    if (before === groupId) return true;
    const change = beginMembershipChange(kind, [itemId], groupId);
    patchMembership(kind, assign([itemId], groupId));
    try {
      await ipc.setItemGroup(kind, itemId, groupId);
      change.settle();
      return true;
    } catch (e) {
      change.drop();
      // Leave a newer move alone.
      if (groupOf(kind, itemId) === groupId) patchMembership(kind, assign([itemId], before));
      refused(kind === "project" ? "Couldn't move the project" : "Couldn't move the workspace", e);
      return false;
    }
  },

  moveItems: async (kind, itemIds, groupId) => {
    const before = new Map<string, string | null>();
    for (const id of itemIds) {
      const from = groupOf(kind, id);
      if (from !== groupId) before.set(id, from);
    }
    const moving = [...before.keys()];
    if (moving.length === 0) return true;
    if (moving.length === 1) return get().moveItem(kind, moving[0], groupId);
    const change = beginMembershipChange(kind, moving, groupId);
    patchMembership(kind, assign(moving, groupId));
    try {
      await ipc.setItemsGroup(kind, moving, groupId);
      change.settle();
      return true;
    } catch (e) {
      change.drop();
      // Leave newer moves alone.
      patchMembership(
        kind,
        new Map(moving.filter((id) => groupOf(kind, id) === groupId).map((id) => [id, before.get(id) ?? null] as const)),
      );
      refused(
        kind === "project" ? `Couldn't move the ${moving.length} projects` : `Couldn't move the ${moving.length} workspaces`,
        e,
      );
      return false;
    }
  },

  pruneProject: (projectId) =>
    set((s) => ({ groups: s.groups.filter((g) => g.projectId !== projectId) })),
}));

/** Test-only: forget the reads and changes in flight. */
export function __resetGroupsStoreInFlight(): void {
  epoch = 0;
  changesInFlight.clear();
  reading = null;
  readAgain = false;
}

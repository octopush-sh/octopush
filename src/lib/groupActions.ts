// What the rail's menus and gestures do to groups, at both scopes: mission
// groups (folders of one project's missions) and project groups (sections of
// projects). The store
// (`groupsStore`) owns the data and its rollbacks; this module adds what a
// gesture needs around it: the name goes into inline edit after a create, the
// target of a move unfolds so the result is visible, and Ungroup can be undone.

import { pushToast } from "../components/Toasts";
import { useGroupsStore } from "../stores/groupsStore";
import { useProjectStore } from "../stores/projectStore";
import { useRailGroupUi } from "../stores/railGroupUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { layoutProjects, projectGroupsOf, resolveTopDrop, sectionHeadId, type RailTopItem } from "./railGroups";
import type { ProjectInfo } from "./types";

/** The name a group is born with; the header opens in edit mode with it selected. */
export const NEW_GROUP_NAME = "New group";

/** Create a mission group in `projectId`, around `workspaceId` when given
 *  (empty otherwise), and put its name into inline edit. */
export async function createMissionGroup(projectId: string, workspaceId?: string): Promise<string | null> {
  const created = await useGroupsStore.getState().create({
    scope: "workspace",
    projectId,
    name: NEW_GROUP_NAME,
    memberIds: workspaceId ? [workspaceId] : [],
  });
  if (!created) return null;
  const ui = useRailGroupUi.getState();
  ui.setCollapsed(created.id, false);
  ui.startRename(created.id);
  return created.id;
}

/** Move a mission into a group (which unfolds, so the mission stays in
 *  sight), or out of any group (`null`). */
export function moveMissionToGroup(workspaceId: string, groupId: string | null): Promise<boolean> {
  if (groupId) useRailGroupUi.getState().setCollapsed(groupId, false);
  return useGroupsStore.getState().moveItem("workspace", workspaceId, groupId);
}

/** The loaded (non-archived) missions of a group. */
function loadedMembers(projectId: string | null, groupId: string): string[] {
  if (!projectId) return [];
  return (useWorkspaceStore.getState().workspacesByProjectId[projectId] ?? [])
    .filter((w) => w.groupId === groupId)
    .map((w) => w.id);
}

/** Remove a group and keep its members. When it had any, the toast offers
 *  Undo, which calls `restore` with the ids that were in it. */
async function ungroup(
  groupId: string,
  members: string[],
  body: (count: number) => string,
  restore: (memberIds: string[]) => void,
): Promise<void> {
  const store = useGroupsStore.getState();
  const group = store.groups.find((g) => g.id === groupId);
  if (!group) return;
  if (!(await store.remove(groupId))) return;
  useRailGroupUi.getState().forget(groupId);
  if (members.length === 0) return;
  pushToast({
    level: "info",
    title: `Ungrouped "${group.name}"`,
    body: body(members.length),
    action: { label: "Undo", onClick: () => restore(members) },
  });
}

/**
 * Remove a group and keep its missions ("Ungroup", or "Remove group" on an
 * empty one). When it had missions the toast offers Undo, which makes a group
 * of the same name and tint around the ones that are still loose. The new
 * group is a new row: it opens unfolded, and archived missions that sat in the
 * old group do not return to it. Undo does nothing once the project has been
 * closed or deleted.
 */
export async function ungroupMissions(groupId: string): Promise<void> {
  const group = useGroupsStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return;
  await ungroup(
    groupId,
    loadedMembers(group.projectId, groupId),
    (count) => (count === 1 ? "Its mission is back in the list." : "Its missions are back in the list."),
    (members) => {
      // The project was closed or deleted since: its rows are gone from the
      // rail, and a group made now would be an empty one nobody can see.
      const rows = group.projectId
        ? useWorkspaceStore.getState().workspacesByProjectId[group.projectId]
        : undefined;
      if (!rows) return;
      const stillLoose = new Set(rows.filter((w) => !w.groupId).map((w) => w.id));
      void useGroupsStore.getState().create({
        scope: "workspace",
        projectId: group.projectId,
        name: group.name,
        tint: group.tint,
        memberIds: members.filter((id) => stillLoose.has(id)),
      });
    },
  );
}

// ───────────────────────────── project groups ─────────────────────────────

/** The projects the rail lists, in its order: the open ones, then the current
 *  one when it is not among them yet (one just created). */
function railProjects(): ProjectInfo[] {
  const { recent, current } = useProjectStore.getState();
  return current && !recent.some((p) => p.id === current.id) ? [...recent, current] : recent;
}

/** The rail's top level as it stands: loose projects and sections. */
function railLayout(): RailTopItem<ProjectInfo>[] {
  return layoutProjects(railProjects(), projectGroupsOf(useGroupsStore.getState().groups));
}

/** Persist a project order. A refusal is logged and the rail keeps the order
 *  it had: the membership change it came with has its own rollback. */
function persistProjectOrder(ids: string[]) {
  void useProjectStore
    .getState()
    .setOrder(ids)
    .catch((e) => console.error("Failed to persist the project order:", e));
}

/** Create a project group around `projectId` and put its name into inline
 *  edit. It stands where the project stands. */
export async function createProjectGroup(projectId: string): Promise<string | null> {
  const created = await useGroupsStore.getState().create({
    scope: "project",
    name: NEW_GROUP_NAME,
    memberIds: [projectId],
  });
  if (!created) return null;
  const ui = useRailGroupUi.getState();
  ui.setCollapsed(created.id, false);
  ui.startRename(created.id);
  return created.id;
}

/**
 * Move a project into a project group, where it becomes the last project
 * (the group unfolds so it stays in sight), or out of any group (`null`),
 * where it stays at its own place in the order. `order` is the project order
 * that goes with the move when the caller already knows it (a drag); left
 * out, joining a group persists the order that puts the project last in it.
 */
export async function moveProjectToGroup(
  projectId: string,
  groupId: string | null,
  order?: string[] | null,
): Promise<boolean> {
  if (groupId) useRailGroupUi.getState().setCollapsed(groupId, false);
  const next =
    order !== undefined
      ? order
      : groupId
        ? (resolveTopDrop(railLayout(), projectId, sectionHeadId(groupId))?.order ?? null)
        : null;
  const ok = await useGroupsStore.getState().moveItem("project", projectId, groupId);
  if (ok && next) persistProjectOrder(next);
  return ok;
}

/**
 * Remove a project group and keep its projects ("Ungroup", or "Remove group"
 * on an empty one). When it had projects the toast offers Undo, which makes a
 * group of the same name and tint around the ones that are still loose and
 * still open; closed projects that sat in the old group do not return to it.
 */
export async function ungroupProjects(groupId: string): Promise<void> {
  const group = useGroupsStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return;
  await ungroup(
    groupId,
    railProjects()
      .filter((p) => p.groupId === groupId)
      .map((p) => p.id),
    (count) => (count === 1 ? "Its project is back in the list." : "Its projects are back in the list."),
    (members) => {
      const stillLoose = new Set(
        railProjects()
          .filter((p) => !p.groupId)
          .map((p) => p.id),
      );
      const memberIds = members.filter((id) => stillLoose.has(id));
      // Every project was closed, deleted or grouped again since: a group
      // made now would be an empty one at the foot of the rail.
      if (memberIds.length === 0) return;
      void useGroupsStore.getState().create({
        scope: "project",
        name: group.name,
        tint: group.tint,
        memberIds,
      });
    },
  );
}

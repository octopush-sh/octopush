// What the rail's menus and gestures do to mission groups. The store
// (`groupsStore`) owns the data and its rollbacks; this module adds what a
// gesture needs around it: the name goes into inline edit after a create, the
// target of a move unfolds so the result is visible, and Ungroup can be undone.

import { pushToast } from "../components/Toasts";
import { useGroupsStore } from "../stores/groupsStore";
import { useRailGroupUi } from "../stores/railGroupUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

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

/**
 * Remove a group and keep its missions ("Ungroup", or "Remove group" on an
 * empty one). When it had missions the toast offers Undo, which makes a group
 * of the same name and tint around the ones that are still loose. The new
 * group is a new row: it opens unfolded, and archived missions that sat in the
 * old group do not return to it.
 */
export async function ungroupMissions(groupId: string): Promise<void> {
  const store = useGroupsStore.getState();
  const group = store.groups.find((g) => g.id === groupId);
  if (!group) return;
  const members = loadedMembers(group.projectId, groupId);
  if (!(await store.remove(groupId))) return;
  useRailGroupUi.getState().forget(groupId);
  if (members.length === 0) return;
  pushToast({
    level: "info",
    title: `Ungrouped "${group.name}"`,
    body: members.length === 1 ? "Its mission is back in the list." : "Its missions are back in the list.",
    action: {
      label: "Undo",
      onClick: () => {
        const stillLoose = new Set(
          (useWorkspaceStore.getState().workspacesByProjectId[group.projectId ?? ""] ?? [])
            .filter((w) => !w.groupId)
            .map((w) => w.id),
        );
        void useGroupsStore.getState().create({
          scope: "workspace",
          projectId: group.projectId,
          name: group.name,
          tint: group.tint,
          memberIds: members.filter((id) => stillLoose.has(id)),
        });
      },
    },
  });
}

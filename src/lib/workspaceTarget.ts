/**
 * Where selecting a workspace has to go. `workspaceStore.select` only knows
 * the open project's workspaces, so a workspace of another project needs a
 * project switch first (remember it as that project's active workspace, then
 * open the project). Shared by the rail and by `octo:navigate` jumps such as
 * the setup-failure toast, which often fires after the user changed project.
 */
export type WorkspaceTarget =
  | { kind: "here" }
  | { kind: "switch"; projectId: string; projectPath: string };

export function resolveWorkspaceTarget(
  workspaceId: string,
  workspacesByProjectId: Record<string, { id: string }[]>,
  currentProjectId: string | null | undefined,
  recentProjects: { id: string; path: string }[],
): WorkspaceTarget {
  const projectId = Object.entries(workspacesByProjectId).find(([, wss]) =>
    wss.some((w) => w.id === workspaceId),
  )?.[0];
  if (!projectId || projectId === currentProjectId) return { kind: "here" };
  const projectPath = recentProjects.find((p) => p.id === projectId)?.path;
  if (!projectPath) return { kind: "here" };
  return { kind: "switch", projectId, projectPath };
}

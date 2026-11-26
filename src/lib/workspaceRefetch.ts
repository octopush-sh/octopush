/**
 * Reads something for one workspace and applies it only if that workspace is
 * still the active one when the answer lands. A commit in workspace A
 * followed by a quick switch to B must not paint A's git status on B (#908).
 * Resolves to whether the answer was applied; a failed read rejects.
 */
export async function refetchForWorkspace<T>(
  workspaceId: string,
  read: () => Promise<T>,
  activeWorkspaceId: () => string | null,
  apply: (value: T) => void,
): Promise<boolean> {
  const value = await read();
  if (activeWorkspaceId() !== workspaceId) return false;
  apply(value);
  return true;
}

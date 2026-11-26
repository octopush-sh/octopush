// Archiving merged missions (#963): the rail's "Merged · archive?" and the
// project menu's "Archive merged missions…". Nothing is archived without a
// click, and the toast offers Undo, which restores the worktrees from their
// kept branches. The backend re-checks every mission at the moment it acts
// (`archive_merged_workspaces`) and leaves alone the ones that changed since
// the offer.

import { pushToast } from "../components/Toasts";
import { ipc } from "./ipc";
import type { ArchiveSkipReason, Workspace } from "./types";
import { useGroupsStore } from "../stores/groupsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const plural = (n: number) => (n === 1 ? "mission" : "missions");

/** Why a mission was left in place, finishing "fix-a …". */
const SKIPPED: Record<ArchiveSkipReason, string> = {
  busy: "has a Talk turn or a Direct run going",
  changed: "has uncommitted changes",
  moved: "has commits after its merged PR",
  "local-files": "now holds local files",
  unverified: "couldn't be checked against GitHub",
  gone: "is no longer an active mission",
  failed: "could not be archived",
};

/** The skipped notice's body: one sentence per mission, the first four. */
export function skippedBody(skipped: readonly { name: string; reason: ArchiveSkipReason }[]): string {
  const lines = skipped.slice(0, 4).map((s) => `${s.name} ${SKIPPED[s.reason] ?? SKIPPED.failed}.`);
  const more = skipped.length - lines.length;
  return [...lines, ...(more > 0 ? [`And ${more} more.`] : [])].join(" ");
}

/** Archive `missions` of the project at `projectPath`, each only if it still
 *  passes when the backend acts, then say how it went. `named`: per mission,
 *  the local files its confirm showed, the only ones it may delete. A mission
 *  already being archived is left out (a double click). Resolves to the ids
 *  that were archived. */
export async function archiveMergedMissions(
  projectId: string,
  projectPath: string,
  candidates: readonly Workspace[],
  named: Readonly<Record<string, readonly string[]>> = {},
): Promise<string[]> {
  const store = useWorkspaceStore.getState();
  const busy = store.archivingIds;
  const missions = candidates.filter((w) => !busy[w.id]);
  if (missions.length === 0) return [];
  const ids = missions.map((w) => w.id);
  const localFilesOk = Object.fromEntries(ids.filter((id) => named[id]?.length).map((id) => [id, [...named[id]]]));
  store.setArchiving(ids, true);
  let result;
  try {
    result = await ipc.archiveMergedWorkspaces(projectId, projectPath, ids, localFilesOk);
  } catch (err) {
    pushToast({ level: "error", title: "Archive failed", body: String(err) });
    return [];
  } finally {
    store.setArchiving(ids, false);
  }
  const archived = new Set(result.archived);
  const done = missions.filter((w) => archived.has(w.id));
  for (const ws of done) store.forgetArchived(ws.id);
  if (result.skipped.length > 0) {
    const name = (id: string) => missions.find((w) => w.id === id)?.name || "A mission";
    const skipped = result.skipped.map((s) => ({ name: name(s.workspaceId), reason: s.reason }));
    pushToast({
      level: "warning",
      title: skipped.length === 1 ? `Skipped "${skipped[0].name}"` : `Skipped ${skipped.length} missions`,
      body: skippedBody(skipped),
    });
    // What the rail offered is stale for these: read it again.
    void store.loadMergedPrs(projectId, projectPath);
  }
  if (done.length > 0) {
    pushToast({
      level: "success",
      title: done.length === 1 ? `Archived "${done[0].name}"` : `Archived ${done.length} merged missions`,
      body: done.length === 1 ? "Its PR is merged; the branch is kept." : "Their PRs are merged; the branches are kept.",
      action: { label: "Undo", onClick: () => void restoreMissions(projectId, projectPath, done) },
    });
  }
  return done.map((w) => w.id);
}

/** Undo: bring the archived missions back (their worktrees are rebuilt from
 *  the kept branches) and reload the project's rail data. */
async function restoreMissions(projectId: string, projectPath: string, missions: readonly Workspace[]): Promise<void> {
  let failed = 0;
  for (const ws of missions) {
    try {
      await ipc.restoreWorkspace(ws.id, projectPath, ws.branch ?? "", ws.worktreePath ?? null);
    } catch {
      failed += 1;
    }
  }
  const store = useWorkspaceStore.getState();
  await store.loadAllWorkspaces([projectId]);
  void useGroupsStore.getState().load();
  void store.loadGitSummaries(projectId);
  void store.loadMergedPrs(projectId, projectPath);
  if (failed > 0) {
    pushToast({ level: "error", title: "Restore failed", body: `${failed} ${plural(failed)} could not be restored.` });
  }
}

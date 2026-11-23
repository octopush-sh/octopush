// Archiving merged missions (#963): the rail's "Merged · archive?" and the
// project menu's "Archive merged missions…". Nothing is archived without a
// click, and the toast offers Undo, which restores the worktrees from their
// kept branches.

import { pushToast } from "../components/Toasts";
import { ipc } from "./ipc";
import type { Workspace } from "./types";
import { useGroupsStore } from "../stores/groupsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const plural = (n: number) => (n === 1 ? "mission" : "missions");

/** Archive `missions` of the project at `projectPath`, one after another,
 *  then say how it went. Resolves to the ids that were archived. */
export async function archiveMergedMissions(
  projectId: string,
  projectPath: string,
  missions: readonly Workspace[],
): Promise<string[]> {
  const store = useWorkspaceStore.getState();
  const done: Workspace[] = [];
  let failure: unknown = null;
  for (const ws of missions) {
    try {
      await store.archive(ws.id, projectPath, ws.branch ?? "", ws.worktreePath ?? null);
      done.push(ws);
    } catch (err) {
      failure = err;
    }
  }
  if (failure !== null) {
    pushToast({ level: "error", title: "Archive failed", body: String(failure) });
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

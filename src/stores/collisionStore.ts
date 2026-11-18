/**
 * Collision radar (#732) — which live workspaces of a project change the same
 * files. Warn only: nothing here ever blocks an action.
 *
 * Cost is bounded twice. Here, `refresh` is throttled per project
 * (`MIN_REFRESH_MS`) and deduped while a scan is in flight, and the poll runs
 * at a modest `POLL_MS` only while the window is visible. In the backend, a
 * project's report is reused for a few seconds and committed diffs and merge
 * confirmations are cached by commit id (`src-tauri/src/collisions.rs`).
 */
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { collisionsByWorkspace, type WorkspaceCollision } from "../lib/collisions";

/** A project is rescanned at most this often, unless forced. */
export const MIN_REFRESH_MS = 10_000;
/** The background poll. Workspace changes (commits, agent edits) have no
 *  watcher event, so this is what notices them between explicit refreshes. */
export const POLL_MS = 60_000;

interface CollisionState {
  /** workspace id → its collisions, worst first. Absent = nothing to say. */
  byWorkspace: Record<string, WorkspaceCollision[]>;
  /** project id → the workspace ids its last report covered. */
  idsByProject: Record<string, string[]>;
  /** Rescan one project. Throttled to `MIN_REFRESH_MS` unless `force`
   *  (a commit, an explicit user action) and deduped while in flight; a
   *  force that arrives mid-scan queues one forced follow-up, since the scan
   *  in flight may predate what prompted it. */
  refresh: (projectId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Poll `projectIds()` every `POLL_MS` while the window is visible.
   *  Returns the stop function. */
  startPolling: (projectIds: () => string[]) => () => void;
  /** A workspace was archived or deleted: drop its entries and every peer's
   *  collision with it at once, then rescan its project (forced, so a scan in
   *  flight that still saw it is followed by one that doesn't). The poll skips
   *  a project left with one workspace, so nothing else would clear them. */
  forgetWorkspace: (workspaceId: string) => void;
  /** Test seam. */
  reset: () => void;
}

const inFlight = new Set<string>();
/** Projects owed one forced rescan once their in-flight scan settles. */
const queuedForce = new Set<string>();
const lastAt = new Map<string, number>();

export const useCollisionStore = create<CollisionState>((set, get) => ({
  byWorkspace: {},
  idsByProject: {},

  refresh: async (projectId, opts) => {
    if (!projectId) return;
    if (inFlight.has(projectId)) {
      if (opts?.force) queuedForce.add(projectId);
      return;
    }
    const now = Date.now();
    if (!opts?.force && now - (lastAt.get(projectId) ?? -Infinity) < MIN_REFRESH_MS) return;
    lastAt.set(projectId, now);
    inFlight.add(projectId);
    try {
      const report = await ipc.projectCollisions(projectId, !!opts?.force);
      const mine = collisionsByWorkspace(report.collisions);
      set((s) => {
        const next = { ...s.byWorkspace };
        for (const id of s.idsByProject[projectId] ?? []) delete next[id];
        Object.assign(next, mine);
        return { byWorkspace: next, idsByProject: { ...s.idsByProject, [projectId]: Object.keys(mine) } };
      });
    } catch {
      // Non-critical: keep the last report rather than flicker the glyphs away.
    } finally {
      inFlight.delete(projectId);
    }
    if (queuedForce.delete(projectId)) await get().refresh(projectId, { force: true });
  },

  startPolling: (projectIds) => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const id of projectIds()) void get().refresh(id);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  },

  forgetWorkspace: (workspaceId) => {
    const projectId = Object.keys(get().idsByProject).find((p) =>
      get().idsByProject[p].includes(workspaceId),
    );
    if (!projectId) return;
    set((s) => {
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      const ids: string[] = [];
      for (const id of s.idsByProject[projectId]) {
        if (!next[id]) continue;
        const rest = next[id].filter((c) => c.otherId !== workspaceId);
        if (rest.length) {
          next[id] = rest;
          ids.push(id);
        } else {
          delete next[id];
        }
      }
      return { byWorkspace: next, idsByProject: { ...s.idsByProject, [projectId]: ids } };
    });
    void get().refresh(projectId, { force: true });
  },

  reset: () => {
    inFlight.clear();
    queuedForce.clear();
    lastAt.clear();
    set({ byWorkspace: {}, idsByProject: {} });
  },
}));

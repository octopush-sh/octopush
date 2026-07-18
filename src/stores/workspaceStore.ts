import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { useProjectStore } from "./projectStore";
import type { Workspace, WorkspaceGitSummary, Pr } from "../lib/types";

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  loading: boolean;
  notifications: Record<string, number>;
  /**
   * Remembers the last workspace selected per project, so that switching
   * back to a project restores the previously viewed workspace instead of
   * jumping to the first one in the list.
   */
  lastActiveByProject: Record<string, string>;
  /** Workspaces grouped by project ID for hierarchical display in the rail. */
  workspacesByProjectId: Record<string, Workspace[]>;
  /** Per-workspace git signal for the rail, keyed by workspace id. */
  gitSummaryByWs: Record<string, WorkspaceGitSummary>;
  /** Open PR per workspace id (null = none), for the rail indicator. */
  prByWs: Record<string, Pr | null>;

  load: (projectId: string) => Promise<void>;
  /** Fetches + replaces workspacesByProjectId for the given ids; also syncs
   *  the flat `workspaces` array (and reconciles `activeId`) when the
   *  currently-open project is among them, so `activeWorkspace` resolves
   *  correctly. Called on project-set changes, on archived-workspace
   *  restore, and (unconditionally, since it's idempotent) on window focus —
   *  the last picks up workspaces authored externally via octopush-mcp. */
  loadAllWorkspaces: (projectIds: string[]) => Promise<void>;
  create: (projectId: string, projectPath: string, name: string, task: string,
           branch: string, fromBranch: string, setupScript: string,
           intent?: string | null, gitIsolation?: string | null) => Promise<Workspace>;
  select: (id: string | null) => void;
  /** Self-heal for the currently-open project: call when `activeId` doesn't
   *  resolve to a workspace even though `workspacesByProjectId[projectId]` is
   *  non-empty — a stale/inconsistent state that must never render the
   *  "No workspaces here yet" screen (see App.tsx's empty-project gate).
   *  Syncs the flat `workspaces` array from the map and activates the
   *  remembered workspace, falling back to the first. Returns false (no-op)
   *  when the project genuinely has none. */
  healActiveForProject: (projectId: string) => boolean;
  /**
   * Record (and persist) which workspace was last active for a project without
   * changing the currently-active workspace. Used when switching INTO another
   * project from the rail so that the project-load picks the clicked workspace.
   */
  rememberActiveForProject: (projectId: string, workspaceId: string) => void;
  remove: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) => Promise<void>;
  /** Archive a workspace (worktree removed, branch kept) — drops it from the rail. */
  archive: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) => Promise<void>;
  /** Rename a workspace in the backend + both rail maps. */
  rename: (workspaceId: string, name: string) => Promise<void>;
  /** Drop a whole project's workspaces from the rail map; clears the active
   *  workspace too if it belonged to that project. Used on project close/delete. */
  pruneProject: (projectId: string) => void;
  /** Fetch + merge a project's per-workspace git summaries into the cache. */
  loadGitSummaries: (projectId: string) => Promise<void>;
  /** Fetch a project's open PRs (gh batch) and map them onto its workspaces by branch. */
  loadProjectPrs: (projectId: string, projectPath: string) => Promise<void>;
  updateCustomization: (workspaceId: string, glyph: string | null, tint: string | null) => Promise<void>;
  notify: (workspaceId: string) => void;
  clearNotification: (workspaceId: string) => void;
}

// Restore lastActiveByProject from localStorage on module load
/** Project ids with an in-flight open-PR fetch — dedupes overlapping
 *  loadProjectPrs calls (each spawns a login-shell `gh` subprocess). */
const prFetchInFlight = new Set<string>();
/** Last successful-start timestamp per project — throttles loadProjectPrs so
 *  the same project isn't re-fetched more than once per 15s (focus +
 *  project-set + pin/reorder can all fire in quick succession). */
const prFetchLastAt = new Map<string, number>();

/** Test-only: clears the module-level PR-fetch dedup/throttle state so the
 *  throttle Map doesn't leak across tests sharing a projectId. */
export const __resetPrFetchThrottle = (): void => {
  prFetchInFlight.clear();
  prFetchLastAt.clear();
};

const loadLastActiveFromStorage = (): Record<string, string> => {
  try {
    const stored = localStorage.getItem("lastActiveWorkspacePerProject");
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,
  loading: false,
  notifications: {},
  lastActiveByProject: loadLastActiveFromStorage(),
  workspacesByProjectId: {},
  gitSummaryByWs: {},
  prByWs: {},

  load: async (projectId) => {
    set({ loading: true });
    const workspaces = await ipc.listWorkspaces(projectId);
    // Atomic update: pick the activeId in the same set() call so React never
    // sees a frame with `workspaces.find(activeId) === undefined`, which
    // would briefly flip activeWorkspace to null and unmount all the
    // TerminalPanes (killing their PTYs). Prefer the last-active for this
    // project, fall back to the first workspace.
    const remembered = get().lastActiveByProject[projectId];
    const exists = remembered && workspaces.some((w) => w.id === remembered);
    const nextActive = exists
      ? remembered
      : workspaces.length > 0
        ? workspaces[0].id
        : null;
    set((s) => ({
      workspaces,
      loading: false,
      activeId: nextActive,
      workspacesByProjectId: {
        ...s.workspacesByProjectId,
        [projectId]: workspaces,
      },
    }));
  },

  loadAllWorkspaces: async (projectIds) => {
    if (projectIds.length === 0) return;
    set({ loading: true });
    try {
      const results = await Promise.all(
        projectIds.map(async (id) => {
          const wss = await ipc.listWorkspaces(id);
          return { projectId: id, workspaces: wss };
        })
      );
      set((s) => {
        const newByProject = { ...s.workspacesByProjectId };
        results.forEach(({ projectId, workspaces }) => {
          newByProject[projectId] = workspaces;
        });
        // `activeWorkspace` in App.tsx resolves against the flat `workspaces`
        // array, not this map. If the currently-open project is among the
        // refreshed ids, keep that array in sync too — otherwise a workspace
        // that just appeared in the rail (via the map) resolves to null when
        // clicked, blanking the canvas.
        const currentProjectId = useProjectStore.getState().current?.id;
        const current = currentProjectId
          ? results.find((r) => r.projectId === currentProjectId)
          : undefined;
        if (!current) {
          return { workspacesByProjectId: newByProject, loading: false };
        }
        const activeStillExists = current.workspaces.some((w) => w.id === s.activeId);
        return {
          workspacesByProjectId: newByProject,
          loading: false,
          workspaces: current.workspaces,
          activeId: activeStillExists ? s.activeId : (current.workspaces[0]?.id ?? null),
        };
      });
    } catch (err) {
      console.error("loadAllWorkspaces failed:", err);
      set({ loading: false });
    }
  },

  healActiveForProject: (projectId) => {
    const state = get();
    const wss = state.workspacesByProjectId[projectId] ?? [];
    if (wss.length === 0) return false;
    const remembered = state.lastActiveByProject[projectId];
    const nextActive = remembered && wss.some((w) => w.id === remembered)
      ? remembered
      : wss[0].id;
    set({ workspaces: wss, activeId: nextActive });
    return true;
  },

  create: async (projectId, projectPath, name, task, branch, fromBranch, setupScript, intent = null, gitIsolation = null) => {
    const ws = await ipc.createWorkspace(projectId, projectPath, name, task, branch, fromBranch, setupScript, intent, gitIsolation);
    // Only the currently-open project owns the flat `workspaces`/`activeId`.
    // Creating for any other project must not steal focus or corrupt that
    // list — it just lands in the per-project map for the rail (C3).
    const isActiveProject = useProjectStore.getState().current?.id === projectId;
    // Creation is idempotent on (project, branch): the backend may return a
    // workspace that already exists (e.g. reusing an existing branch). Upsert by
    // id so the rail never grows a duplicate row / duplicate React key.
    const upsert = (list: Workspace[]) => {
      const i = list.findIndex((w) => w.id === ws.id);
      if (i === -1) return [...list, ws];
      const next = list.slice();
      next[i] = ws;
      return next;
    };
    set((s) => {
      const updated = { ...s.lastActiveByProject, [projectId]: ws.id };
      try {
        localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
      } catch (err) {
        console.error("Failed to persist lastActiveByProject:", err);
      }
      return {
        // New workspaces sit at the end of their project's list (matching the
        // backend's created_at ASC ordering); reused ones replace in place.
        workspaces: isActiveProject ? upsert(s.workspaces) : s.workspaces,
        activeId: isActiveProject ? ws.id : s.activeId,
        lastActiveByProject: updated,
        workspacesByProjectId: {
          ...s.workspacesByProjectId,
          [projectId]: upsert(s.workspacesByProjectId[projectId] || []),
        },
      };
    });
    return ws;
  },

  select: (id) =>
    set((s) => {
      const next: Partial<WorkspaceState> = { activeId: id };
      if (id !== null) {
        // Persist the selection per-project so re-entering a project
        // restores the workspace the user was last viewing.
        const ws = s.workspaces.find((w) => w.id === id);
        if (ws) {
          const updated = {
            ...s.lastActiveByProject,
            [ws.projectId]: id,
          };
          next.lastActiveByProject = updated;
          // Persist to localStorage
          try {
            localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
          } catch (err) {
            console.error("Failed to persist lastActiveByProject:", err);
          }
        }
      }
      return next as WorkspaceState;
    }),

  rememberActiveForProject: (projectId, workspaceId) =>
    set((s) => {
      const updated = { ...s.lastActiveByProject, [projectId]: workspaceId };
      try {
        localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
      } catch (err) {
        console.error("Failed to persist lastActiveByProject:", err);
      }
      return { lastActiveByProject: updated };
    }),

  remove: async (workspaceId, projectPath, branch, worktreePath) => {
    await ipc.deleteWorkspace(workspaceId, projectPath, branch, worktreePath);
    set((s) => {
      // Drop the workspace from every project's group too — the rail renders
      // from `workspacesByProjectId`, so leaving a stale entry there keeps the
      // deleted workspace visible even though it's gone from disk.
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, wss] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = wss.filter((w) => w.id !== workspaceId);
      }
      const { [workspaceId]: _droppedSummary, ...nextSummaries } = s.gitSummaryByWs;
      const { [workspaceId]: _droppedPr, ...nextPrs } = s.prByWs;
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        workspacesByProjectId: nextByProject,
        gitSummaryByWs: nextSummaries,
        prByWs: nextPrs,
        activeId: s.activeId === workspaceId ? null : s.activeId,
      };
    });
  },

  archive: async (workspaceId, projectPath, branch, worktreePath) => {
    await ipc.archiveWorkspace(workspaceId, projectPath, branch, worktreePath);
    // Archived rows are excluded from list_workspaces, so drop locally like
    // remove (also prune the git summary for hygiene).
    set((s) => {
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, wss] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = wss.filter((w) => w.id !== workspaceId);
      }
      const { [workspaceId]: _dropped, ...nextSummaries } = s.gitSummaryByWs;
      const { [workspaceId]: _droppedPr, ...nextPrs } = s.prByWs;
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        workspacesByProjectId: nextByProject,
        gitSummaryByWs: nextSummaries,
        prByWs: nextPrs,
        activeId: s.activeId === workspaceId ? null : s.activeId,
      };
    });
  },

  rename: async (workspaceId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await ipc.renameWorkspace(workspaceId, trimmed);
    set((s) => {
      const patch = (w: Workspace) => (w.id === workspaceId ? { ...w, name: trimmed } : w);
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, wss] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = wss.map(patch);
      }
      return {
        workspaces: s.workspaces.map(patch),
        workspacesByProjectId: nextByProject,
      };
    });
  },

  pruneProject: (projectId) =>
    set((s) => {
      const removed = s.workspacesByProjectId[projectId] ?? [];
      const removedIds = new Set(removed.map((w) => w.id));
      const { [projectId]: _dropped, ...restByProject } = s.workspacesByProjectId;
      // If the active workspace belonged to the pruned project, the flat list
      // is now that project's — clear it so the app falls to the empty state.
      const activeWasPruned = !!s.activeId && removedIds.has(s.activeId);
      const nextSummaries = { ...s.gitSummaryByWs };
      for (const id of removedIds) delete nextSummaries[id];
      const nextPrs = { ...s.prByWs };
      for (const id of removedIds) delete nextPrs[id];
      return {
        workspacesByProjectId: restByProject,
        workspaces: activeWasPruned ? [] : s.workspaces,
        activeId: activeWasPruned ? null : s.activeId,
        gitSummaryByWs: nextSummaries,
        prByWs: nextPrs,
      };
    }),

  loadGitSummaries: async (projectId) => {
    try {
      const summaries = await ipc.workspacesGitSummary(projectId);
      set((s) => {
        const next = { ...s.gitSummaryByWs };
        for (const sum of summaries) next[sum.workspaceId] = sum;
        return { gitSummaryByWs: next };
      });
    } catch {
      // Non-critical — the rail just shows no signal for this project.
    }
  },

  loadProjectPrs: async (projectId, projectPath) => {
    if (prFetchInFlight.has(projectId)) return;
    const now = Date.now();
    if (now - (prFetchLastAt.get(projectId) ?? 0) < 15_000) return;
    prFetchLastAt.set(projectId, now);
    prFetchInFlight.add(projectId);
    try {
      const branchPrs = await ipc.openPrsForProject(projectPath);
      const byBranch = new Map(branchPrs.map((bp) => [bp.branch, bp.pr]));
      set((s) => {
        const wss = s.workspacesByProjectId[projectId] ?? [];
        const next = { ...s.prByWs };
        for (const w of wss) next[w.id] = byBranch.get(w.branch) ?? null;
        return { prByWs: next };
      });
    } catch {
      // Non-critical — no PR indicators for this project.
    } finally {
      prFetchInFlight.delete(projectId);
    }
  },

  updateCustomization: async (workspaceId, glyph, tint) => {
    await ipc.updateWorkspaceCustomization(workspaceId, glyph, tint as any);
    set((s) => {
      const patch = (w: Workspace) =>
        w.id === workspaceId
          ? { ...w, glyph: glyph as any, tint: tint as any }
          : w;
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, list] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = list.map(patch);
      }
      return {
        workspaces: s.workspaces.map(patch),
        workspacesByProjectId: nextByProject,
      };
    });
  },

  notify: (workspaceId) =>
    set((s) => ({
      notifications: {
        ...s.notifications,
        [workspaceId]: (s.notifications[workspaceId] ?? 0) + 1,
      },
    })),

  clearNotification: (workspaceId) =>
    set((s) => ({
      notifications: { ...s.notifications, [workspaceId]: 0 },
    })),
}));

/** The workspace's display name from whichever project list holds it — the
 *  ONE lookup shared by Mission Control, crew notifications, and friends. */
export function findWorkspaceName(
  workspacesByProjectId: Record<string, { id: string; name: string }[]>,
  workspaceId: string,
): string | null {
  for (const list of Object.values(workspacesByProjectId)) {
    const ws = list.find((w) => w.id === workspaceId);
    if (ws) return ws.name;
  }
  return null;
}

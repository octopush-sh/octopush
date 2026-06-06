import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { useProjectStore } from "./projectStore";
import type { Workspace, WorkspaceGitSummary } from "../lib/types";

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

  load: (projectId: string) => Promise<void>;
  loadAllWorkspaces: (projectIds: string[]) => Promise<void>;
  create: (projectId: string, projectPath: string, name: string, task: string,
           branch: string, fromBranch: string, setupScript: string) => Promise<Workspace>;
  select: (id: string | null) => void;
  /**
   * Record (and persist) which workspace was last active for a project without
   * changing the currently-active workspace. Used when switching INTO another
   * project from the rail so that the project-load picks the clicked workspace.
   */
  rememberActiveForProject: (projectId: string, workspaceId: string) => void;
  remove: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) => Promise<void>;
  /** Drop a whole project's workspaces from the rail map; clears the active
   *  workspace too if it belonged to that project. Used on project close/delete. */
  pruneProject: (projectId: string) => void;
  /** Fetch + merge a project's per-workspace git summaries into the cache. */
  loadGitSummaries: (projectId: string) => Promise<void>;
  updateCustomization: (workspaceId: string, glyph: string | null, tint: string | null) => Promise<void>;
  notify: (workspaceId: string) => void;
  clearNotification: (workspaceId: string) => void;
}

// Restore lastActiveByProject from localStorage on module load
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
        return { workspacesByProjectId: newByProject, loading: false };
      });
    } catch (err) {
      console.error("loadAllWorkspaces failed:", err);
      set({ loading: false });
    }
  },

  create: async (projectId, projectPath, name, task, branch, fromBranch, setupScript) => {
    const ws = await ipc.createWorkspace(projectId, projectPath, name, task, branch, fromBranch, setupScript);
    // Only the currently-open project owns the flat `workspaces`/`activeId`.
    // Creating for any other project must not steal focus or corrupt that
    // list — it just lands in the per-project map for the rail (C3).
    const isActiveProject = useProjectStore.getState().current?.id === projectId;
    set((s) => {
      const updated = { ...s.lastActiveByProject, [projectId]: ws.id };
      try {
        localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
      } catch (err) {
        console.error("Failed to persist lastActiveByProject:", err);
      }
      return {
        // New workspaces sit at the end of their project's list (matching the
        // backend's created_at ASC ordering).
        workspaces: isActiveProject ? [...s.workspaces, ws] : s.workspaces,
        activeId: isActiveProject ? ws.id : s.activeId,
        lastActiveByProject: updated,
        workspacesByProjectId: {
          ...s.workspacesByProjectId,
          [projectId]: [...(s.workspacesByProjectId[projectId] || []), ws],
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
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        workspacesByProjectId: nextByProject,
        gitSummaryByWs: nextSummaries,
        activeId: s.activeId === workspaceId ? null : s.activeId,
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
      return {
        workspacesByProjectId: restByProject,
        workspaces: activeWasPruned ? [] : s.workspaces,
        activeId: activeWasPruned ? null : s.activeId,
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

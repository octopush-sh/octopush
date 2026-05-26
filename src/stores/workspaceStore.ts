import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Workspace } from "../lib/types";

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

  load: (projectId: string) => Promise<void>;
  loadAllWorkspaces: (projectIds: string[]) => Promise<void>;
  create: (projectId: string, projectPath: string, name: string, task: string,
           branch: string, fromBranch: string, setupScript: string) => Promise<Workspace>;
  select: (id: string | null) => void;
  remove: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) => Promise<void>;
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
    set((s) => {
      const updated = { ...s.lastActiveByProject, [projectId]: ws.id };
      try {
        localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
      } catch (err) {
        console.error("Failed to persist lastActiveByProject:", err);
      }
      return {
        workspaces: [ws, ...s.workspaces],
        activeId: ws.id,
        lastActiveByProject: updated,
        workspacesByProjectId: {
          ...s.workspacesByProjectId,
          [projectId]: [ws, ...(s.workspacesByProjectId[projectId] || [])],
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

  remove: async (workspaceId, projectPath, branch, worktreePath) => {
    await ipc.deleteWorkspace(workspaceId, projectPath, branch, worktreePath);
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
      activeId: s.activeId === workspaceId ? null : s.activeId,
    }));
  },

  updateCustomization: async (workspaceId, glyph, tint) => {
    await ipc.updateWorkspaceCustomization(workspaceId, glyph, tint as any);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, glyph: (glyph as any), tint: (tint as any) }
          : w,
      ),
    }));
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

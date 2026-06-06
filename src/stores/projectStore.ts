import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ProjectInfo } from "../lib/types";

interface ProjectState {
  current: ProjectInfo | null;
  recent: ProjectInfo[];
  closed: ProjectInfo[];
  loading: boolean;
  error: string | null;

  open: (path: string) => Promise<void>;
  create: (path: string, name: string) => Promise<void>;
  loadRecent: () => Promise<void>;
  loadClosed: () => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  reopenProject: (id: string) => Promise<void>;
  close: () => void;
  getLastOpenedPath: () => string | null;
  saveLastOpenedPath: (path: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  current: null,
  recent: [],
  closed: [],
  loading: false,
  error: null,

  open: async (path) => {
    set({ loading: true, error: null });
    try {
      const project = await ipc.openProject(path);
      set({ current: project, loading: false });
      // Persist last opened project path
      try {
        localStorage.setItem("lastOpenedProjectPath", path);
      } catch (err) {
        console.error("Failed to save lastOpenedProjectPath:", err);
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  create: async (path, name) => {
    set({ loading: true, error: null });
    try {
      const project = await ipc.createProject(path, name);
      set({ current: project, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadRecent: async () => {
    try {
      const recent = await ipc.listRecentProjects();
      set({ recent });
    } catch {
      // Ignore — recent list is non-critical
    }
  },

  loadClosed: async () => {
    try {
      const closed = await ipc.listClosedProjects();
      set({ closed });
    } catch {
      // Ignore — closed list is non-critical.
    }
  },

  closeProject: async (id) => {
    await ipc.closeProject(id);
    const [recent, closed] = await Promise.all([
      ipc.listRecentProjects(),
      ipc.listClosedProjects(),
    ]);
    set((s) => ({
      recent,
      closed,
      // Closing the currently-open project drops the app to the empty state
      // instead of leaving a stale `current` pointing at a hidden project (C2).
      current: s.current?.id === id ? null : s.current,
    }));
  },

  reopenProject: async (id) => {
    await ipc.reopenProject(id);
    const [recent, closed] = await Promise.all([
      ipc.listRecentProjects(),
      ipc.listClosedProjects(),
    ]);
    set({ recent, closed });
  },

  close: () => set({ current: null }),

  getLastOpenedPath: () => {
    try {
      return localStorage.getItem("lastOpenedProjectPath");
    } catch {
      return null;
    }
  },

  saveLastOpenedPath: (path) => {
    try {
      localStorage.setItem("lastOpenedProjectPath", path);
    } catch (err) {
      console.error("Failed to save lastOpenedProjectPath:", err);
    }
  },
}));

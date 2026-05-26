import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ProjectInfo } from "../lib/types";

interface ProjectState {
  current: ProjectInfo | null;
  recent: ProjectInfo[];
  loading: boolean;
  error: string | null;

  open: (path: string) => Promise<void>;
  create: (path: string, name: string) => Promise<void>;
  loadRecent: () => Promise<void>;
  close: () => void;
  getLastOpenedPath: () => string | null;
  saveLastOpenedPath: (path: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  current: null,
  recent: [],
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

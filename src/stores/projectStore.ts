import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { loadWithMembership } from "../lib/membershipGuard";
import type { ProjectInfo } from "../lib/types";

// Both lists are read under the membership guard, so a reload already in
// flight never undoes a group move (see `lib/membershipGuard.ts`).
const listRecent = () => loadWithMembership("project", () => ipc.listRecentProjects());
const listClosed = () => loadWithMembership("project", () => ipc.listClosedProjects());

interface ProjectState {
  current: ProjectInfo | null;
  recent: ProjectInfo[];
  closed: ProjectInfo[];
  loading: boolean;
  error: string | null;

  open: (path: string) => Promise<void>;
  create: (path: string, name: string, task?: string | null) => Promise<void>;
  loadRecent: () => Promise<void>;
  loadClosed: () => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  reopenProject: (id: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setOrder: (ids: string[]) => Promise<void>;
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

  create: async (path, name, task) => {
    set({ loading: true, error: null });
    try {
      const project = await ipc.createProject(path, name, task);
      set({ current: project, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadRecent: async () => {
    try {
      const recent = await listRecent();
      set({ recent });
    } catch {
      // Ignore — recent list is non-critical
    }
  },

  loadClosed: async () => {
    try {
      const closed = await listClosed();
      set({ closed });
    } catch {
      // Ignore — closed list is non-critical.
    }
  },

  closeProject: async (id) => {
    await ipc.closeProject(id);
    const [recent, closed] = await Promise.all([
      listRecent(),
      listClosed(),
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
      listRecent(),
      listClosed(),
    ]);
    set({ recent, closed });
  },

  setPinned: async (id, pinned) => {
    await ipc.setProjectPinned(id, pinned);
    const recent = await listRecent();
    set({ recent });
  },

  setOrder: async (ids) => {
    await ipc.setProjectOrder(ids);
    const recent = await listRecent();
    set({ recent });
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

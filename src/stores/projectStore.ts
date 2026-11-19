import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { beginMembershipLoad, type MembershipLoad } from "../lib/membershipGuard";
import type { ProjectInfo } from "../lib/types";

/**
 * Reread project lists under the membership guard (`lib/membershipGuard.ts`).
 * `read` fetches one list or several; `commit` writes the store, passing each
 * list through `overlay`, which lays over it every group move the read could
 * have missed. `commit` runs in the same step as the overlay, so a reload in
 * flight never undoes a move, and never brings back one the backend refused.
 */
async function reload<R>(
  read: () => Promise<R>,
  commit: (lists: R, overlay: MembershipLoad["overlay"]) => void,
): Promise<void> {
  const guard = beginMembershipLoad("project");
  try {
    commit(await read(), guard.overlay);
  } finally {
    guard.end();
  }
}

const readRecent = () => ipc.listRecentProjects();
const readBoth = () => Promise.all([ipc.listRecentProjects(), ipc.listClosedProjects()]);

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
      await reload(readRecent, (recent, overlay) => set({ recent: overlay(recent) }));
    } catch {
      // Ignore — recent list is non-critical
    }
  },

  loadClosed: async () => {
    try {
      await reload(
        () => ipc.listClosedProjects(),
        (closed, overlay) => set({ closed: overlay(closed) }),
      );
    } catch {
      // Ignore — closed list is non-critical.
    }
  },

  closeProject: async (id) => {
    await ipc.closeProject(id);
    await reload(readBoth, ([recent, closed], overlay) =>
      set((s) => ({
        recent: overlay(recent),
        closed: overlay(closed),
        // Closing the currently-open project drops the app to the empty state
        // instead of leaving a stale `current` pointing at a hidden project (C2).
        current: s.current?.id === id ? null : s.current,
      })),
    );
  },

  reopenProject: async (id) => {
    await ipc.reopenProject(id);
    await reload(readBoth, ([recent, closed], overlay) =>
      set({ recent: overlay(recent), closed: overlay(closed) }),
    );
  },

  setPinned: async (id, pinned) => {
    await ipc.setProjectPinned(id, pinned);
    await reload(readRecent, (recent, overlay) => set({ recent: overlay(recent) }));
  },

  setOrder: async (ids) => {
    await ipc.setProjectOrder(ids);
    await reload(readRecent, (recent, overlay) => set({ recent: overlay(recent) }));
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

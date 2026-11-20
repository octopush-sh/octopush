import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { beginMembershipLoad, type MembershipLoad } from "../lib/membershipGuard";
import type { ProjectInfo } from "../lib/types";

/**
 * `rows` in the order the backend lists them once `ids` is stored: pinned
 * first, then the order of `ids`. Rows `ids` leaves out follow, in their own
 * order; a list that holds none of `ids` (the closed projects) is left as is.
 */
export function arrangeProjects<T extends { id: string; pinned?: boolean }>(rows: T[], ids: readonly string[]): T[] {
  const at = new Map(ids.map((id, index) => [id, index] as const));
  if (!rows.some((p) => at.has(p.id))) return rows;
  const listed = rows
    .filter((p) => at.has(p.id))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || at.get(a.id)! - at.get(b.id)!);
  return [...listed, ...rows.filter((p) => !at.has(p.id))];
}

// The newest project order written optimistically, for the reloads: one that
// started before it settled read the old order and gets it laid over.
let orderClock = 0;
let pendingOrder: { ids: string[]; settledAt: number | null } | null = null;

/** A handle on one project-order write, from the optimistic order to the
 *  backend's answer. */
export interface ProjectOrderChange {
  settle: () => void;
  /** The backend refused it: reloads stop laying it over. */
  drop: () => void;
}

/** Record that `ids` is being written as the project order. Call it in the
 *  step that puts the order in the store, before the request. */
export function beginProjectOrderChange(ids: string[]): ProjectOrderChange {
  const mine = { ids, settledAt: null as number | null };
  pendingOrder = mine;
  return {
    settle: () => {
      mine.settledAt = ++orderClock;
    },
    drop: () => {
      if (pendingOrder === mine) pendingOrder = null;
    },
  };
}

/**
 * Reread project lists under the membership guard (`lib/membershipGuard.ts`).
 * `read` fetches one list or several; `commit` writes the store, passing each
 * list through `overlay`, which lays over it every group move the read could
 * have missed, and the project order still being written. `commit` runs in
 * the same step as the overlay, so a reload in flight never undoes a move or
 * a reorder, and never brings back one the backend refused.
 */
async function reload<R>(
  read: () => Promise<R>,
  commit: (lists: R, overlay: MembershipLoad["overlay"]) => void,
): Promise<void> {
  const guard = beginMembershipLoad("project");
  const startedAt = ++orderClock;
  const overlay: MembershipLoad["overlay"] = (rows) => {
    const moved = guard.overlay(rows);
    const order = pendingOrder;
    return order && (order.settledAt === null || order.settledAt > startedAt)
      ? arrangeProjects(moved, order.ids)
      : moved;
  };
  try {
    commit(await read(), overlay);
  } finally {
    guard.end();
  }
}

const sameIds = (rows: readonly { id: string }[], ids: readonly string[]) =>
  rows.length === ids.length && rows.every((p, index) => p.id === ids[index]);

/** Test-only: forget the order being written. */
export function __resetProjectOrderInFlight(): void {
  orderClock = 0;
  pendingOrder = null;
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
  /** Store a manual project order: the rail shows it at once, and gets the
   *  old one back (and the call rejects) if the backend refuses it. */
  setOrder: (ids: string[]) => Promise<void>;
  close: () => void;
  getLastOpenedPath: () => string | null;
  saveLastOpenedPath: (path: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
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
    const before = get().recent.map((p) => p.id);
    const change = beginProjectOrderChange(ids);
    set((s) => ({ recent: arrangeProjects(s.recent, ids) }));
    const placed = get().recent.map((p) => p.id);
    try {
      await ipc.setProjectOrder(ids);
      change.settle();
    } catch (e) {
      change.drop();
      // Leave a newer reorder alone.
      if (sameIds(get().recent, placed)) set((s) => ({ recent: arrangeProjects(s.recent, before) }));
      throw e;
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

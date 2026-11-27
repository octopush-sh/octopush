import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
import { nextPermissionMode, threadModeOf, type PermissionMode, type ThreadMode } from "../lib/permissionModes";

interface PermissionModeState {
  /** Each conversation's mode, once read. */
  byThread: Record<string, ThreadMode>;
  /** Read a conversation's mode (and whether a mission forces it). */
  load: (threadId: string) => Promise<void>;
  /** Set it. Shown at once; a running turn takes it from its next round.
   *  Does nothing while a read-only mission forces Plan only. */
  set: (threadId: string, mode: PermissionMode) => Promise<void>;
  /** The next mode in the cycle (the Composer's chord). */
  cycle: (threadId: string) => Promise<void>;
}

/** Per conversation: the last read asked for, the sets not yet answered, and
 *  the queue that keeps sets in the order they were made. */
const loadSeq: Record<string, number> = {};
const pendingSets: Record<string, number> = {};
const queues: Record<string, Promise<unknown>> = {};

export const usePermissionModeStore = create<PermissionModeState>((set, get) => ({
  byThread: {},

  load: async (threadId) => {
    const seq = (loadSeq[threadId] = (loadSeq[threadId] ?? 0) + 1);
    try {
      const mode = threadModeOf(await ipc.getThreadPermissionMode(threadId));
      // A newer read, or a set still in flight, has the say.
      if (loadSeq[threadId] !== seq || (pendingSets[threadId] ?? 0) > 0) return;
      set((s) => ({ byThread: { ...s.byThread, [threadId]: mode } }));
    } catch {
      // The control keeps what it last knew.
    }
  },

  set: async (threadId, mode) => {
    const before = get().byThread[threadId];
    if (before?.forced) return;
    set((s) => ({ byThread: { ...s.byThread, [threadId]: { stored: mode, effective: mode, forced: false } } }));
    pendingSets[threadId] = (pendingSets[threadId] ?? 0) + 1;
    const run = (queues[threadId] ?? Promise.resolve()).then(() => ipc.setThreadPermissionMode(threadId, mode));
    queues[threadId] = run.catch(() => undefined);
    try {
      await run;
    } catch (e) {
      // Put back what was shown, unless a later choice replaced it.
      if (get().byThread[threadId]?.stored === mode) {
        set((s) => {
          const byThread = { ...s.byThread };
          if (before) byThread[threadId] = before;
          else delete byThread[threadId];
          return { byThread };
        });
      }
      pushToast({ level: "error", title: "Couldn't change the permission mode", body: String(e) });
    } finally {
      pendingSets[threadId] -= 1;
    }
    if (pendingSets[threadId] === 0) await get().load(threadId);
  },

  cycle: async (threadId) => {
    const current = get().byThread[threadId];
    if (!current || current.forced) return;
    await get().set(threadId, nextPermissionMode(current.effective));
  },
}));

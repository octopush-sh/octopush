import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc, type BackgroundProcess } from "../lib/ipc";

/** The event that carries a conversation's background processes, whole, on
 *  every change (`chat_engine::BACKGROUND_PROCESSES_EVENT`). */
export const BACKGROUND_PROCESSES_EVENT = "chat://background-processes";

const NONE: BackgroundProcess[] = [];

/** The agent's background processes per Talk conversation (#1160), so the
 *  live process panel shows every one and can stop it. Loaded when the
 *  panel shows a conversation, then kept current by the backend's event. */
interface BackgroundProcessState {
  byThread: Record<string, BackgroundProcess[]>;
  /** Ids being stopped, so a Stop isn't sent twice. */
  stopping: Record<string, true>;
  load: (threadId: string) => Promise<void>;
  apply: (threadId: string, processes: BackgroundProcess[]) => void;
  stop: (threadId: string, id: string) => Promise<void>;
}

export const useBackgroundProcessStore = create<BackgroundProcessState>((set, get) => ({
  byThread: {},
  stopping: {},

  load: async (threadId) => {
    try {
      get().apply(threadId, await ipc.listBackgroundProcesses(threadId));
    } catch {
      // No daemon, or an older backend: the panel shows none.
    }
  },

  apply: (threadId, processes) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: processes.length ? processes : NONE } })),

  stop: async (threadId, id) => {
    const key = `${threadId}/${id}`;
    if (get().stopping[key]) return;
    set((s) => ({ stopping: { ...s.stopping, [key]: true } }));
    try {
      await ipc.stopBackgroundProcess(threadId, id);
    } catch {
      // The event, or the next load, says how it stands.
    } finally {
      set((s) => {
        const next = { ...s.stopping };
        delete next[key];
        return { stopping: next };
      });
    }
  },
}));

/** A conversation's processes; a stable empty list when it has none. */
export function selectBackgroundProcesses(threadId: string | undefined) {
  return (s: BackgroundProcessState) => (threadId ? s.byThread[threadId] ?? NONE : NONE);
}

/** The processes the panel lists: the running ones. A promoted command is
 *  left out while the panel's terminal streams it (`liveShown`), as a long
 *  `$` command is; after a restart nothing streams it, so it is listed. */
export function listedProcesses(processes: BackgroundProcess[], liveShown: boolean): BackgroundProcess[] {
  return processes.filter((p) => p.running && (p.kind === "background" || !liveShown));
}

/** How a process stands, in a few words for its row. */
export function processStatus(p: BackgroundProcess): string {
  if (p.running) return "running";
  if (p.stopped) return "stopped";
  if (p.lost) return "lost";
  return p.exitCode === null ? "ended" : `exit ${p.exitCode}`;
}

void listen<{ workspaceId: string; threadId: string; processes: BackgroundProcess[] }>(
  BACKGROUND_PROCESSES_EVENT,
  (ev) => {
    const p = ev.payload;
    if (!p?.threadId || !Array.isArray(p.processes)) return;
    useBackgroundProcessStore.getState().apply(p.threadId, p.processes);
  },
);

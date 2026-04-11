import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { CreateSessionArgs, Session } from "../lib/types";

interface SessionState {
  sessions: Session[];
  activeId: string | null;
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  create: (args: CreateSessionArgs) => Promise<Session>;
  select: (id: string | null) => void;
  kill: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await ipc.listSessions();
      set({ sessions, loading: false });
      // Auto-select the most recent if none active
      if (!get().activeId && sessions.length > 0) {
        set({ activeId: sessions[0].id });
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  create: async (args) => {
    const session = await ipc.createSession(args);
    set((s) => ({
      sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
      activeId: session.id,
    }));
    return session;
  },

  select: (id) => set({ activeId: id }),

  kill: async (id) => {
    await ipc.killSession(id);
    await get().refresh();
  },

  remove: async (id) => {
    await ipc.deleteSession(id);
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  },
}));

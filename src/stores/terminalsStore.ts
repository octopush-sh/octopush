import { create } from "zustand";
import { ipc } from "../lib/ipc";

// ─── State shape ──────────────────────────────────────────────────

/** Runtime view of a terminal tab. `id` doubles as the PTY session id. */
export interface TerminalState {
  id: string;
  label: string;
  position: number;
  /** true once the frontend has spawned a PTY for this id this app session */
  running: boolean;
}

// Stable empty list — returning a new array per call would bust React memo.
const EMPTY_TERMINALS: TerminalState[] = [];

// ─── Store interface ──────────────────────────────────────────────

interface TerminalsStore {
  terminalsByWs: Record<string, TerminalState[]>;
  activeByWs: Record<string, string | null>;

  // Selectors
  getTerminals: (workspaceId: string) => TerminalState[];
  getActiveId: (workspaceId: string) => string | null;

  // Actions
  loadTerminals: (workspaceId: string) => Promise<void>;
  createTerminal: (workspaceId: string, label?: string) => Promise<TerminalState>;
  renameTerminal: (workspaceId: string, id: string, label: string) => Promise<void>;
  deleteTerminal: (workspaceId: string, id: string) => Promise<void>;
  setActive: (workspaceId: string, id: string | null) => void;
  markRunning: (workspaceId: string, id: string, running: boolean) => void;
}

// ─── Store implementation ─────────────────────────────────────────

export const useTerminalsStore = create<TerminalsStore>((set, get) => ({
  terminalsByWs: {},
  activeByWs: {},

  // ── Selectors ─────────────────────────────────────────────────

  getTerminals: (workspaceId) =>
    get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS,

  getActiveId: (workspaceId) => {
    const byWs = get().activeByWs;
    return workspaceId in byWs ? byWs[workspaceId] : null;
  },

  // ── Actions ───────────────────────────────────────────────────

  loadTerminals: async (workspaceId) => {
    const records = await ipc.listTerminals(workspaceId);
    const terminals: TerminalState[] = records.map((r) => ({
      id: r.id,
      label: r.label,
      position: r.position,
      running: false,
    }));
    set((s) => {
      const currentActive = s.activeByWs[workspaceId] ?? null;
      const newActive =
        currentActive !== null
          ? currentActive
          : terminals.length > 0
            ? terminals[0].id
            : null;
      return {
        terminalsByWs: { ...s.terminalsByWs, [workspaceId]: terminals },
        activeByWs: { ...s.activeByWs, [workspaceId]: newActive },
      };
    });
  },

  createTerminal: async (workspaceId, labelOverride) => {
    const existing = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const label =
      labelOverride ??
      (existing.length === 0 ? "Main" : `Terminal ${existing.length + 1}`);

    const record = await ipc.createTerminal(workspaceId, label);
    const newTerminal: TerminalState = {
      id: record.id,
      label: record.label,
      position: record.position,
      running: false,
    };

    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: [...prev, newTerminal],
        },
        activeByWs: { ...s.activeByWs, [workspaceId]: newTerminal.id },
      };
    });

    return newTerminal;
  },

  renameTerminal: async (workspaceId, id, label) => {
    // Optimistic update
    const prev = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const updated = prev.map((t) => (t.id === id ? { ...t, label } : t));
    set((s) => ({
      terminalsByWs: { ...s.terminalsByWs, [workspaceId]: updated },
    }));

    try {
      await ipc.renameTerminal(id, label);
    } catch (err) {
      // Revert on failure
      set((s) => ({
        terminalsByWs: { ...s.terminalsByWs, [workspaceId]: prev },
      }));
      throw err;
    }
  },

  deleteTerminal: async (workspaceId, id) => {
    const prev = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const remaining = prev.filter((t) => t.id !== id);

    // Determine next active: pick neighbor, or null if list empties.
    const currentActive = get().activeByWs[workspaceId] ?? null;
    let nextActive: string | null = currentActive;
    if (currentActive === id) {
      const idx = prev.findIndex((t) => t.id === id);
      // Prefer the item that comes after; fall back to the one before.
      nextActive =
        remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }

    set((s) => ({
      terminalsByWs: { ...s.terminalsByWs, [workspaceId]: remaining },
      activeByWs: { ...s.activeByWs, [workspaceId]: nextActive },
    }));

    await ipc.deleteTerminal(id);
  },

  setActive: (workspaceId, id) =>
    set((s) => ({
      activeByWs: { ...s.activeByWs, [workspaceId]: id },
    })),

  markRunning: (workspaceId, id, running) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: prev.map((t) =>
            t.id === id ? { ...t, running } : t,
          ),
        },
      };
    }),
}));

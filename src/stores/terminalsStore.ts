import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { pushToast } from "../components/Toasts";

// ─── State shape ──────────────────────────────────────────────────

/** Runtime view of a terminal tab. `id` doubles as the PTY session id. */
export interface TerminalState {
  id: string;
  label: string;
  position: number;
  /** true once the frontend has spawned (or reattached) a PTY for this id */
  running: boolean;
  /**
   * Transient flag: true when this terminal was reattached to a surviving
   * daemon session on startup (as opposed to a fresh spawn).  Cleared after
   * 5 seconds by a store-level timer so the badge auto-dismisses whether or
   * not the Terminals panel is mounted.
   */
  restored: boolean;
}

// Stable empty list — returning a new array per call would bust React memo.
const EMPTY_TERMINALS: TerminalState[] = [];

// ─── Module-level bookkeeping ─────────────────────────────────────

// Per-workspace load generation. Mutations (create/delete) bump it so a
// `loadTerminals` whose IPC fetch was in flight across the mutation discards
// its now-stale snapshot instead of resurrecting deleted rows.
const loadGenByWs = new Map<string, number>();
const bumpLoadGen = (workspaceId: string) =>
  loadGenByWs.set(workspaceId, (loadGenByWs.get(workspaceId) ?? 0) + 1);

// Guard against double-scheduling the 5s restored-badge expiry when a
// workspace is re-loaded while a timer is already pending.
const restoredExpiryScheduled = new Set<string>();

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
  /** Clear the transient `restored` badge for a given terminal. */
  clearRestored: (workspaceId: string, id: string) => void;
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
    // Capture the generation before the fetch; a create/delete that lands
    // while the IPC round-trip is in flight bumps it, marking us stale.
    const gen = loadGenByWs.get(workspaceId) ?? 0;

    // Fetch DB records and live daemon sessions in parallel.
    const [records, liveSessions] = await Promise.all([
      ipc.listTerminals(workspaceId),
      ipc.listPtySessions().catch(() => [] as import("../lib/types").PtySession[]),
    ]);

    if ((loadGenByWs.get(workspaceId) ?? 0) !== gen) return; // stale; discard

    // Build a fast lookup of daemon-live ids.
    const liveRunningIds = new Set(
      liveSessions.filter((s) => s.running).map((s) => s.id),
    );

    set((s) => {
      // Preserve `running` for terminals already in the store — TerminalPane
      // doesn't unmount when the user navigates away, so existing PTYs are
      // still alive. Treating a workspace re-load as "everything stopped"
      // would desync the status dots.
      const prev = s.terminalsByWs[workspaceId];
      const prevRunningById = new Map(
        (prev ?? []).map((t) => [t.id, t.running]),
      );

      const terminals: TerminalState[] = records.map((r) => {
        // A terminal is "running" if:
        //   (a) it was already marked running in the store (from a live TerminalPane
        //       in this Octopush session), OR
        //   (b) the daemon reports it as alive — meaning we're on startup and
        //       it survived from the previous Octopush session.
        const wasRunningInStore = prevRunningById.get(r.id) ?? false;
        const daemonRunning = liveRunningIds.has(r.id);
        const running = wasRunningInStore || daemonRunning;

        // `restored` is set when the daemon has it but the store didn't — i.e.,
        // this is the first load of a surviving session after Octopush restart.
        // If it was already in the store as running, it's not a "new restore".
        const restored = daemonRunning && !wasRunningInStore;

        return {
          id: r.id,
          label: r.label,
          position: r.position,
          running,
          restored,
        };
      });

      // Preserve the active selection only if it still exists in the fresh
      // list; otherwise fall back to the first terminal (or null).
      const currentActive = s.activeByWs[workspaceId] ?? null;
      const newActive =
        currentActive !== null && terminals.some((t) => t.id === currentActive)
          ? currentActive
          : terminals.length > 0
            ? terminals[0].id
            : null;
      return {
        terminalsByWs: { ...s.terminalsByWs, [workspaceId]: terminals },
        activeByWs: { ...s.activeByWs, [workspaceId]: newActive },
      };
    });

    // Auto-expire `restored` badges after 5s — store-level so the badge
    // clears even if the Terminals panel is never mounted.
    for (const t of get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS) {
      if (!t.restored) continue;
      const key = `${workspaceId}:${t.id}`;
      if (restoredExpiryScheduled.has(key)) continue;
      restoredExpiryScheduled.add(key);
      setTimeout(() => {
        restoredExpiryScheduled.delete(key);
        get().clearRestored(workspaceId, t.id);
      }, 5000);
    }
  },

  createTerminal: async (workspaceId, labelOverride) => {
    const existing = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const label =
      labelOverride ??
      (existing.length === 0 ? "Main" : `Terminal ${existing.length + 1}`);

    const record = await ipc.createTerminal(workspaceId, label);
    bumpLoadGen(workspaceId); // invalidate any in-flight loadTerminals snapshot
    const newTerminal: TerminalState = {
      id: record.id,
      label: record.label,
      position: record.position,
      running: false,
      restored: false,
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
    // Confirm with the backend FIRST — an optimistic removal would leave the
    // UI lying about a terminal that still exists if the IPC call fails.
    try {
      await ipc.deleteTerminal(id);
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't close terminal", body: String(e) });
      return; // state untouched
    }

    bumpLoadGen(workspaceId); // invalidate any in-flight loadTerminals snapshot

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

  clearRestored: (workspaceId, id) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: prev.map((t) =>
            t.id === id ? { ...t, restored: false } : t,
          ),
        },
      };
    }),
}));

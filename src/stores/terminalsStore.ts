import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
import { isModalOpen } from "../components/ModalShell";
import { roleForCommand, type SessionRole } from "../lib/sessionRole";
import type { SetupRun } from "../lib/setupRun";
import { navigate } from "../lib/tour/surfaces";
import { useAttentionStore } from "./attentionStore";
import {
  EMPTY_RUN_LAYOUT,
  MAX_SLOTS,
  assign,
  besideAction,
  besideReplaces,
  besideSlot,
  focusedId,
  leave,
  openBeside,
  prune,
  pruneTalk,
  seatTalk,
  toggleTalk,
  useTerminalLayoutStore,
  type RunLayout,
} from "./terminalLayoutStore";

// ─── State shape ──────────────────────────────────────────────────

/** Runtime view of a terminal tab. `id` doubles as the PTY session id. */
export interface TerminalState {
  id: string;
  label: string;
  position: number;
  /** true once the frontend has spawned (or reattached) a PTY for this id */
  running: boolean;
  /** true when the last spawn-or-attach for this id was rejected (no shell,
   *  sandbox denial, daemon down). Cleared by the next successful spawn.
   *  Absent is the same as false. */
  failed?: boolean;
  /** true until the PTY's first output (the prompt, or replayed scrollback)
   *  reaches the pane — exactly while the canvas reads "Starting shell in …".
   *  Absent is the same as false. */
  starting?: boolean;
  /** true while a non-shell command is executing in this PTY (foreground
   *  process != shell). Distinct from `running` (= shell session alive);
   *  driven by the daemon's `pty://foreground` events. */
  busy: boolean;
  /**
   * Transient flag: true when this terminal was reattached to a surviving
   * daemon session on startup (as opposed to a fresh spawn).  Cleared after
   * 5 seconds by a store-level timer so the badge auto-dismisses whether or
   * not the Terminals panel is mounted.
   */
  restored: boolean;
  /**
   * What this session is *doing*, derived from the daemon's foreground command
   * and rendered as the session's icon everywhere it appears.
   *
   * **Sticky by design:** it keeps the last *significant* role rather than
   * following every transition back to the prompt, so a dev server that
   * finishes a rebuild is still recognisably the dev server. Only a new
   * meaningful command replaces it.
   */
  role: SessionRole;
  /** The command currently running, or null at the prompt. */
  command: string | null;
}

// Stable empty list — returning a new array per call would bust React memo.
const EMPTY_TERMINALS: TerminalState[] = [];

/** Most panes Run lays out: four, a 2×2 grid. */
export const RUN_PANES = MAX_SLOTS;

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

// The terminals `trackSetup` has ever registered, kept across restarts so a
// replayed exit marker still restores a setup terminal's state. Only these
// honour the marker: any other program printing it changes nothing.
const SETUP_TERMINALS_KEY = "octopush.setupTerminals";
const SETUP_TERMINALS_MAX = 200;

function loadSetupTerminals(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETUP_TERMINALS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveSetupTerminals(ids: string[]) {
  try {
    localStorage.setItem(SETUP_TERMINALS_KEY, JSON.stringify(ids.slice(-SETUP_TERMINALS_MAX)));
  } catch (err) {
    console.error("Failed to persist setup terminals:", err);
  }
}

// ─── Store interface ──────────────────────────────────────────────

interface TerminalsStore {
  terminalsByWs: Record<string, TerminalState[]>;
  /** The focused Run slot's session, derived from `terminalLayoutStore`.
   *  Written only by `updateLayout`. */
  activeByWs: Record<string, string | null>;
  /** Setup-script runs by terminal id (src/lib/setupRun.ts). Live state: after
   *  a restart the replayed exit marker restores it, without a toast. */
  setupByTerminal: Record<string, SetupRun>;

  // Selectors
  getTerminals: (workspaceId: string) => TerminalState[];
  getActiveId: (workspaceId: string) => string | null;

  // Actions
  loadTerminals: (workspaceId: string) => Promise<void>;
  /** Create a session. It goes in the focused pane, or in the slot
   *  `targetSlot` picks from the layout once the session exists (so a layout
   *  that changed meanwhile is respected; `slots.length` appends a new slot).
   *  A slot that can't take it (e.g. -1) leaves it unseated. */
  createTerminal: (
    workspaceId: string,
    label?: string,
    targetSlot?: (layout: RunLayout) => number,
  ) => Promise<TerminalState>;
  renameTerminal: (workspaceId: string, id: string, label: string) => Promise<void>;
  deleteTerminal: (workspaceId: string, id: string) => Promise<void>;
  /** Focus `id`'s pane if it is on screen; otherwise put it in the focused pane. */
  setActive: (workspaceId: string, id: string | null) => void;
  /** The one path that changes Run's layout; derives `activeByWs` from it. */
  updateLayout: (workspaceId: string, fn: (layout: RunLayout) => RunLayout) => void;
  /** What Open beside does now: open the pairing switcher (`"pair"`), leave
   *  an empty seat because every session is on screen (`"seat"`), or nothing. */
  besideAction: (workspaceId: string) => "pair" | "seat" | null;
  /** True when Run has no room and no empty seat: a pick from the pairing
   *  switcher replaces the session in the focused pane. */
  besideReplaces: (workspaceId: string) => boolean;
  /** Put `id` beside the panes — in the empty seat, else a new slot, else the
   *  focused pane — and focus it. `null` leaves an empty seat. */
  openBeside: (workspaceId: string, id: string | null) => void;
  /** Open a new session straight into the slot Open beside fills, chosen
   *  when the session exists; never over a shown session it wasn't asked to
   *  replace. */
  createBeside: (workspaceId: string) => Promise<TerminalState>;
  /** Open a new session straight into Talk's seat. Run leaves it unseated,
   *  unless Run has no session on screen at all. */
  createInTalkSeat: (workspaceId: string) => Promise<TerminalState>;
  /** Talk's seat toggle (the icon, `×`, ⌘D): close an open seat; reopen a
   *  closed one on its session while that still exists (or while the list
   *  isn't loaded yet); else open it empty. Returns `"pick"` when the
   *  pairing switcher should open, null (nothing done) while a dialog owns
   *  the screen. Run's layout and `activeByWs` are never touched. */
  toggleTalkSeat: (workspaceId: string) => "closed" | "opened" | "pick" | null;
  markRunning: (workspaceId: string, id: string, running: boolean) => void;
  /** Record that a terminal's PTY failed to start (or, with `false`, that
   *  the failure was cleared). A failed session is never running. */
  markFailed: (workspaceId: string, id: string, failed: boolean) => void;
  /** The terminal's pane drew its first output: it is no longer starting. */
  markStarted: (workspaceId: string, id: string) => void;
  /** Set whether a command is currently executing in a terminal (foreground
   *  busy), from the daemon's `pty://foreground` events. `command` is the
   *  daemon's argv summary when it could resolve one; it updates the session's
   *  role (stickily) and the command shown while busy. */
  setBusy: (
    workspaceId: string,
    id: string,
    busy: boolean,
    command?: string | null,
  ) => void;
  /** Clear the transient `restored` badge for a given terminal. */
  clearRestored: (workspaceId: string, id: string) => void;
  /** A workspace's setup script just started in terminal `id`; it becomes the
   *  workspace's active session unless more than one pane is open. */
  trackSetup: (workspaceId: string, id: string) => void;
  /** The setup runner in terminal `id` reported `code`. A run seen starting
   *  that fails raises a toast that opens the terminal. */
  reportSetupExit: (workspaceId: string, id: string, code: number) => void;
}

// ─── Store implementation ─────────────────────────────────────────

/** Run's layout for a workspace. One seen for the first time starts as one
 *  pane holding whatever was active. */
function runOf(workspaceId: string): RunLayout {
  return (
    useTerminalLayoutStore.getState().runByWs[workspaceId] ??
    { ...EMPTY_RUN_LAYOUT, slots: [useTerminalsStore.getState().activeByWs[workspaceId] ?? null] }
  );
}

export const useTerminalsStore = create<TerminalsStore>((set, get) => ({
  terminalsByWs: {},
  activeByWs: {},
  setupByTerminal: {},

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
      // Roles and running commands are live state, not DB state — a reload
      // must not reset a session's identity to "shell".
      const prevLiveById = new Map(
        (prev ?? []).map((t) => [
          t.id,
          {
            role: t.role,
            command: t.command,
            failed: t.failed ?? false,
            starting: t.starting ?? false,
          },
        ]),
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
        // A setup terminal the backend spawned this session is new, not a
        // survivor — the store just hadn't listed it yet.
        const restored = daemonRunning && !wasRunningInStore && !(r.id in s.setupByTerminal);

        const live = prevLiveById.get(r.id);
        return {
          id: r.id,
          label: r.label,
          position: r.position,
          running,
          // A spawn failure is live state too; a session that is running
          // after all is no longer failed.
          failed: !running && (live?.failed ?? false),
          // A session new to the store gets its pane now, which shows
          // "Starting shell in …" until the first output.
          starting: live ? live.starting : true,
          busy: false,
          restored,
          role: live?.role ?? ("shell" as SessionRole),
          command: live?.command ?? null,
        };
      });

      return {
        terminalsByWs: { ...s.terminalsByWs, [workspaceId]: terminals },
      };
    });

    // Keep the panes whose sessions still exist; an empty single pane falls
    // back to the first terminal (or stays empty).
    const fresh = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const exists = (id: string) => fresh.some((t) => t.id === id);
    get().updateLayout(workspaceId, (layout) => {
      const kept = prune(layout, exists);
      return kept.slots.length === 1 && focusedId(kept) === null && fresh.length > 0
        ? assign(kept, 0, fresh[0].id)
        : kept;
    });
    useTerminalLayoutStore.getState().updateTalk(workspaceId, (seat) => pruneTalk(seat, exists));

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

  createTerminal: async (workspaceId, labelOverride, targetSlot) => {
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
      starting: true,
      busy: false,
      restored: false,
      role: "shell",
      command: null,
    };

    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: [...prev, newTerminal],
        },
      };
    });
    get().updateLayout(workspaceId, (layout) =>
      assign(layout, targetSlot ? targetSlot(layout) : layout.focused, newTerminal.id),
    );

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

    // An attention marker pointing at this session has nothing left to point
    // at — without this it would keep the workspace in Mission Control's
    // needs-you band and pulsing on the rail forever.
    useAttentionStore.getState().clearForTerminal(workspaceId, id);
    useAttentionStore.getState().setShownWaiting(id, null);

    const prev = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const remaining = prev.filter((t) => t.id !== id);

    const knownSetup = loadSetupTerminals();
    if (knownSetup.includes(id)) saveSetupTerminals(knownSetup.filter((x) => x !== id));

    set((s) => {
      const { [id]: _gone, ...setupByTerminal } = s.setupByTerminal;
      return {
        terminalsByWs: { ...s.terminalsByWs, [workspaceId]: remaining },
        setupByTerminal,
      };
    });
    useTerminalLayoutStore.getState().forget(workspaceId, id);

    // A shown session's slot goes exactly as leaving it would, and a focused
    // one hands focus to the next pane. With no pane left showing a session
    // (it was alone, or beside only an empty seat), one pane takes a
    // neighbour — the one after, else the one before — never one on screen.
    get().updateLayout(workspaceId, (layout) => {
      const slot = layout.slots.indexOf(id);
      if (slot === -1) return layout;
      const left = leave(layout, slot);
      if (left.slots.some((s) => s !== null)) return left;
      const idx = prev.findIndex((t) => t.id === id);
      const order = [...remaining.slice(idx), ...remaining.slice(0, idx).reverse()];
      const next = idx < 0 ? null : order.find((t) => !layout.slots.includes(t.id));
      return assign(left, 0, next?.id ?? null);
    });
  },

  setActive: (workspaceId, id) =>
    get().updateLayout(workspaceId, (layout) => assign(layout, layout.focused, id)),

  updateLayout: (workspaceId, fn) => {
    const next = fn(runOf(workspaceId));
    useTerminalLayoutStore.getState().commitRun(workspaceId, next);
    const id = focusedId(next);
    const byWs = get().activeByWs;
    if (workspaceId in byWs && byWs[workspaceId] === id) return;
    set((s) => ({ activeByWs: { ...s.activeByWs, [workspaceId]: id } }));
  },

  besideAction: (workspaceId) => {
    const layout = runOf(workspaceId);
    const terminals = get().terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
    const hasHidden = terminals.some((t) => !layout.slots.includes(t.id));
    return besideAction(layout, hasHidden, RUN_PANES);
  },

  besideReplaces: (workspaceId) => besideReplaces(runOf(workspaceId), RUN_PANES),

  openBeside: (workspaceId, id) =>
    get().updateLayout(workspaceId, (layout) => openBeside(layout, id, RUN_PANES)),

  // The slot is picked when the session exists. If the seat or the room went
  // while it was being created, it stays off screen rather than replace a
  // shown session — unless replacing was what the user asked for.
  createBeside: (workspaceId) => {
    const replaces = besideReplaces(runOf(workspaceId), RUN_PANES);
    return get().createTerminal(workspaceId, undefined, (layout) =>
      besideReplaces(layout, RUN_PANES) && !replaces ? -1 : besideSlot(layout, RUN_PANES),
    );
  },

  createInTalkSeat: async (workspaceId) => {
    const t = await get().createTerminal(workspaceId, undefined, (layout) =>
      layout.slots.every((s) => s === null) ? layout.focused : -1,
    );
    useTerminalLayoutStore.getState().seatTalkSession(workspaceId, t.id);
    return t;
  },

  toggleTalkSeat: (workspaceId) => {
    if (isModalOpen()) return null;
    const layout = useTerminalLayoutStore.getState();
    const seat = layout.getTalk(workspaceId);
    if (seat.open) {
      layout.updateTalk(workspaceId, toggleTalk);
      return "closed";
    }
    const id = seat.terminalId;
    const known = workspaceId in get().terminalsByWs;
    if (id && (!known || get().getTerminals(workspaceId).some((t) => t.id === id))) {
      layout.seatTalkSession(workspaceId, id);
      return "opened";
    }
    layout.updateTalk(workspaceId, (s) => seatTalk(s, null));
    return "pick";
  },

  markRunning: (workspaceId, id, running) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          // A dead session can't be busy — clear busy when the PTY stops.
          [workspaceId]: prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  running,
                  // A live PTY clears a previous spawn failure.
                  failed: running ? false : t.failed,
                  busy: running ? t.busy : false,
                  command: running ? t.command : null,
                }
              : t,
          ),
        },
      };
    }),

  markFailed: (workspaceId, id, failed) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: prev.map((t) =>
            t.id === id
              ? failed
                ? { ...t, failed: true, running: false, busy: false, command: null }
                : { ...t, failed: false }
              : t,
          ),
        },
      };
    }),

  markStarted: (workspaceId, id) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      if (!prev.some((t) => t.id === id && t.starting)) return s;
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: prev.map((t) => (t.id === id ? { ...t, starting: false } : t)),
        },
      };
    }),

  setBusy: (workspaceId, id, busy, command) =>
    set((s) => {
      const prev = s.terminalsByWs[workspaceId] ?? EMPTY_TERMINALS;
      const target = prev.find((t) => t.id === id);
      if (!target) return s;
      // A later busy tick without a resolvable command (older daemon,
      // unsupported platform) must not erase the command we already showed.
      const nextCommand = busy ? (command ?? target.command) : null;
      // Sticky role: only a command we can actually place replaces the
      // session's identity. "shell" and "unknown" leave it alone, so a dev
      // server keeps its icon through every quiet moment between rebuilds.
      const derived = busy && command ? roleForCommand(command) : null;
      const nextRole =
        derived && derived !== "shell" && derived !== "unknown" ? derived : target.role;
      if (target.busy === busy && target.command === nextCommand && target.role === nextRole) {
        return s;
      }
      return {
        terminalsByWs: {
          ...s.terminalsByWs,
          [workspaceId]: prev.map((t) =>
            t.id === id ? { ...t, busy, command: nextCommand, role: nextRole } : t,
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

  trackSetup: (workspaceId, id) => {
    const known = loadSetupTerminals();
    if (!known.includes(id)) saveSetupTerminals([...known, id]);
    set((s) => ({
      setupByTerminal: {
        ...s.setupByTerminal,
        [id]: { workspaceId, status: "running", exitCode: null },
      },
    }));
    // Never replaces a session on screen: with more than one pane open it
    // starts unseated, and its rail cell marks it as usual.
    get().updateLayout(workspaceId, (layout) =>
      layout.slots.length > 1 ? layout : assign(layout, layout.focused, id),
    );
  },

  reportSetupExit: (workspaceId, id, code) => {
    // Only a setup terminal: the same bytes printed in any other terminal
    // are just output.
    if (!(id in get().setupByTerminal) && !loadSetupTerminals().includes(id)) return;
    const wasRunning = get().setupByTerminal[id]?.status === "running";
    set((s) => ({
      setupByTerminal: {
        ...s.setupByTerminal,
        [id]: { workspaceId, status: code === 0 ? "ok" : "failed", exitCode: code },
      },
    }));
    // Only a run this session saw start: a replayed marker after a restart
    // restores the state quietly instead of re-announcing an old failure.
    if (!wasRunning || code === 0) return;
    pushToast({
      level: "error",
      title: "Setup failed",
      body: `The setup script exited with ${code}. The workspace is ready; its dependencies may not be.`,
      timeout: 10000,
      action: {
        label: "Open the setup terminal",
        onClick: () => navigate({ kind: "terminal", workspaceId, terminalId: id }),
      },
    });
  },
}));

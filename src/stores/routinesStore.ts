import { create } from "zustand";
import { ipc, type Routine, type RoutineInput, type RoutinePhase } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
import { isUpgradeRequired } from "../lib/upgradeError";
import { useUpgradeStore } from "./upgradeStore";

/** Routines (scheduled crews). CRUD over the backend; a refusal that carries an
 *  entitlement error surfaces the upgrade sheet rather than a raw toast. */
interface RoutinesState {
  routines: Routine[];
  loaded: boolean;
  loading: boolean;
  /** Routine ids with an in-flight `runNow` — the button disables + spins while
   *  a fire is running (its condition eval can take up to 30s). */
  runningNow: string[];
  /** The phase each in-flight `runNow` reported last (a fresh routine's setup
   *  script can take up to 10 minutes). */
  phaseById: Record<string, RoutinePhase>;
  load: () => Promise<void>;
  create: (input: RoutineInput) => Promise<boolean>;
  update: (id: string, input: RoutineInput) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  runNow: (id: string) => Promise<void>;
}

/** Map an entitlement refusal to the upgrade sheet; otherwise toast the error.
 *  Returns true when it was an upgrade refusal (handled). */
function handleError(e: unknown, fallbackTitle: string): boolean {
  const upgrade = isUpgradeRequired(e);
  if (upgrade) {
    useUpgradeStore.getState().show(upgrade);
    return true;
  }
  pushToast({ level: "error", title: fallbackTitle, body: String(e).split("\n")[0] });
  return false;
}

/** What an in-flight "Run now" is waiting on, as one mono line. */
export function describeRoutinePhase(phase: RoutinePhase): string {
  switch (phase) {
    case "condition":
      return "checking its condition…";
    case "workspace":
      return "making a fresh workspace…";
    case "setup":
      return "running the setup script…";
    case "launching":
      return "launching the crew…";
  }
}

export const useRoutinesStore = create<RoutinesState>((set, get) => ({
  routines: [],
  loaded: false,
  loading: false,
  runningNow: [],
  phaseById: {},

  load: async () => {
    set({ loading: true });
    try {
      const routines = await ipc.listRoutines();
      set({ routines, loaded: true });
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't load routines", body: String(e).split("\n")[0] });
    } finally {
      set({ loading: false });
    }
  },

  create: async (input) => {
    try {
      await ipc.createRoutine(input);
      await get().load();
      return true;
    } catch (e) {
      handleError(e, "Couldn't save the routine");
      return false;
    }
  },

  update: async (id, input) => {
    try {
      await ipc.updateRoutine(id, input);
      await get().load();
      return true;
    } catch (e) {
      handleError(e, "Couldn't save the routine");
      return false;
    }
  },

  remove: async (id) => {
    // Optimistic — deletion is ungated and near-instant.
    const prev = get().routines;
    set({ routines: prev.filter((r) => r.id !== id) });
    try {
      await ipc.deleteRoutine(id);
    } catch (e) {
      set({ routines: prev });
      pushToast({ level: "error", title: "Couldn't delete the routine", body: String(e).split("\n")[0] });
    }
  },

  setEnabled: async (id, enabled) => {
    try {
      await ipc.setRoutineEnabled(id, enabled);
      await get().load();
    } catch (e) {
      handleError(e, "Couldn't update the routine");
    }
  },

  runNow: async (id) => {
    // Ignore a re-click while this routine's fire is already in flight (its
    // condition eval can take up to 30s) — no duplicate concurrent fires.
    if (get().runningNow.includes(id)) return;
    set({ runningNow: [...get().runningNow, id] });
    // Follow the fire's phases so the row can say what it is waiting on
    // (listening before the fire starts, so its first phase isn't missed).
    const unlisten = await ipc
      .onRoutinePhase((ev) => {
        if (ev.routineId !== id || !get().runningNow.includes(id)) return;
        set({ phaseById: { ...get().phaseById, [id]: ev.phase } });
      })
      .catch(() => null);
    try {
      const outcome = await ipc.runRoutineNow(id);
      if (outcome.outcome === "dispatched") {
        pushToast({ level: "success", title: "Routine dispatched", body: "The crew is on it — follow along in Mission Control." });
      } else if (outcome.skip === "setup_failed") {
        // A real failure, not an empty window: its own toast.
        const detail = outcome.reason?.replace(/^setup failed:\s*/, "");
        pushToast({
          level: "error",
          title: "Setup failed",
          body: detail
            ? `The project's setup script failed in the fresh workspace, so no crew ran (${detail}).`
            : "The project's setup script failed in the fresh workspace, so no crew ran.",
          timeout: 10000,
        });
      } else {
        // Honest skip: show exactly why (condition not met/error, workspace
        // busy/unavailable, launch refused) so "Run now" is a real test.
        pushToast({
          level: "info",
          title: "Nothing to run",
          body: outcome.reason
            ? `The window was skipped — ${outcome.reason}.`
            : "The window was skipped — its workspace is busy, or a previous run is still going.",
        });
      }
      await get().load();
    } catch (e) {
      handleError(e, "Couldn't run the routine");
    } finally {
      unlisten?.();
      const { [id]: _done, ...phaseById } = get().phaseById;
      set({ runningNow: get().runningNow.filter((x) => x !== id), phaseById });
    }
  },
}));

import { create } from "zustand";
import { ipc, type Routine, type RoutineInput } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
import { isUpgradeRequired } from "../lib/upgradeError";
import { useUpgradeStore } from "./upgradeStore";

/** Routines (scheduled crews). CRUD over the backend; a refusal that carries an
 *  entitlement error surfaces the upgrade sheet rather than a raw toast. */
interface RoutinesState {
  routines: Routine[];
  loaded: boolean;
  loading: boolean;
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

export const useRoutinesStore = create<RoutinesState>((set, get) => ({
  routines: [],
  loaded: false,
  loading: false,

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
    try {
      const outcome = await ipc.runRoutineNow(id);
      if (outcome === "dispatched") {
        pushToast({ level: "success", title: "Routine dispatched", body: "The crew is on it — follow along in Mission Control." });
      } else {
        pushToast({ level: "info", title: "Nothing to run", body: "The window was skipped — its workspace is busy, or a previous run is still going." });
      }
      await get().load();
    } catch (e) {
      handleError(e, "Couldn't run the routine");
    }
  },
}));

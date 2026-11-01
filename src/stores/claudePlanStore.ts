import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc, type PlanSnapshot } from "../lib/ipc";
import { PLAN_EVENT } from "../lib/claudePlan";

/** The Claude plan snapshot (`get_claude_plan`), re-read whenever a stage
 *  reports new windows. Detached runs write it from the worker, so the
 *  Companion also reloads when the run's cost moves. */
interface ClaudePlanState {
  windows: PlanSnapshot[];
  load: () => Promise<void>;
}

export const useClaudePlanStore = create<ClaudePlanState>((set) => ({
  windows: [],
  load: async () => {
    try {
      const w = await ipc.getClaudePlan();
      set({ windows: Array.isArray(w) ? w : [] });
    } catch {
      // A missing snapshot is no snapshot: the line simply stays hidden.
    }
  },
}));

// Deferred and guarded: outside Tauri (tests, the clip harness) there is no
// event bus, and the line just keeps its last loaded state.
void Promise.resolve()
  .then(() => listen(PLAN_EVENT, () => void useClaudePlanStore.getState().load()))
  .catch(() => {});

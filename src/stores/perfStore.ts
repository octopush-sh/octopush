import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { PerfStats } from "../lib/types";

interface PerfState {
  stats: PerfStats | null;
  /** The footer's details popover (with Workspace Caches) is open. Lives here
   *  so the Readiness card's disk row can open it. */
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
  start: () => void;
  stop: () => void;
}

const POLL_MS = 2000;
// Module-level timer so it survives component re-renders and start() is idempotent.
let timer: ReturnType<typeof setInterval> | null = null;

export const usePerfStore = create<PerfState>((set) => {
  const tick = async () => {
    // Don't burn cycles sampling when nobody's looking.
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const stats = await ipc.getPerfStats();
      set({ stats });
    } catch {
      // Transient (daemon restart, etc.) — keep the last good reading.
    }
  };

  return {
    stats: null,
    detailsOpen: false,
    setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
    start: () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
});

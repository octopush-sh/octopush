import { create } from "zustand";
import { ipc, type ReadinessCheck } from "../lib/ipc";

/** "Is this Mac ready for a crew?" — the Settings › General readiness card
 *  and the first-run invite share one result. Checks are local commands
 *  (`readiness_check`), each bounded at 3 s on the Rust side; never cached
 *  there, so `check()` always re-probes. */
interface ReadinessState {
  /** null = not checked yet this session. */
  checks: ReadinessCheck[] | null;
  loading: boolean;
  /** The command itself failed (not a check). */
  error: string | null;
  check: () => Promise<void>;
}

export const useReadinessStore = create<ReadinessState>()((set, get) => ({
  checks: null,
  loading: false,
  error: null,

  check: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      set({ checks: await ipc.readinessCheck(), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));

/** True when a check found something a crew will fail on. */
export function hasReadinessFailure(checks: ReadinessCheck[] | null): boolean {
  return !!checks?.some((c) => c.status === "fail");
}

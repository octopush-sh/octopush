import { create } from "zustand";
import { ipc, type ReadinessCheck } from "../lib/ipc";
import { resetClaudeCliVersionCache } from "../lib/claudeCli";

/** One shared result for the Settings › General readiness card and the
 *  first-run invite. `readiness_check` never caches, so `check()` re-probes. */
interface ReadinessState {
  /** null = not checked yet this session. */
  checks: ReadinessCheck[] | null;
  /** When the last successful check answered (epoch ms); null = never. */
  checkedAt: number | null;
  loading: boolean;
  /** The command itself failed (not a check). */
  error: string | null;
  /** `explicit`: the user asked (Check again), so `claude auth status` runs
   *  too; the automatic pass never runs it. */
  check: (opts?: { explicit?: boolean }) => Promise<void>;
}

export const useReadinessStore = create<ReadinessState>()((set, get) => ({
  checks: null,
  checkedAt: null,
  loading: false,
  error: null,

  check: async (opts) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const result: unknown = await ipc.readinessCheck(opts?.explicit === true);
      // A backend that answers with anything but a list reports no checks
      // rather than leaving the card blank.
      const checks = Array.isArray(result) ? (result as ReadinessCheck[]) : [];
      set({ checks, checkedAt: Date.now(), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    } finally {
      // The check re-probed Claude Code and cleared the backend's cached
      // version: after an update, the launcher stops warning on its next open.
      resetClaudeCliVersionCache();
    }
  },
}));

/** True when a check found something a crew will fail on. */
export function hasReadinessFailure(checks: ReadinessCheck[] | null): boolean {
  return !!checks?.some((c) => c.status === "fail");
}

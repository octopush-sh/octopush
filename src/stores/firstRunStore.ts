import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ipc } from "../lib/ipc";

/** The one-shot "put a crew on it" first-run invite (the differentiator's
 *  minute-one moment). Eligibility is the AND of:
 *  - the user has NEVER started a Direct run on this install (all-time backend
 *    count — the monthly quota counter resets and would re-invite returning
 *    users), and
 *  - they haven't dismissed the invite (persisted), and
 *  - they haven't already used it this session (it hands off to the Direct
 *    launcher; no second nudge while the first is in flight). */
interface FirstRunState {
  /** Persisted: the user said "Not now" — never show again. */
  dismissed: boolean;
  /** Session: the CTA was used — hide immediately without persisting
   *  (if no run actually starts, next launch may invite again). */
  usedThisSession: boolean;
  /** null = not yet checked this session. */
  everRan: boolean | null;
  checkEligibility: () => Promise<void>;
  dismiss: () => void;
  markUsed: () => void;
}

export const useFirstRunStore = create<FirstRunState>()(
  persist(
    (set, get) => ({
      dismissed: false,
      usedThisSession: false,
      everRan: null,

      checkEligibility: async () => {
        if (get().dismissed || get().everRan !== null) return;
        try {
          const count = await ipc.countRunsAllTime();
          set({ everRan: count > 0 });
        } catch {
          // Can't tell → don't invite (never nag on a broken read).
          set({ everRan: true });
        }
      },

      dismiss: () => set({ dismissed: true }),
      markUsed: () => set({ usedThisSession: true }),
    }),
    {
      name: "octo-first-run",
      partialize: (s) => ({ dismissed: s.dismissed }),
    },
  ),
);

/** Provider readiness for the crew: any enabled local provider, or any
 *  provider with a configured key. Checked at CTA time so the invite can
 *  route honestly (crew vs. Settings · Models first). */
export async function anyProviderReady(): Promise<boolean> {
  try {
    const [providers, settings] = await Promise.all([ipc.listProviders(), ipc.getSettings()]);
    const keys = (settings as { providerKeys?: Record<string, string> }).providerKeys ?? {};
    return providers.some(
      (p) => (p.local && p.enabled) || (keys[p.name] ?? "").trim().length > 0,
    );
  } catch {
    return false;
  }
}

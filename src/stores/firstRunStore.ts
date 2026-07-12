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
  /** A run started via any path this session — the invite must retire NOW. */
  noteRunStarted: () => void;
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
          set({ everRan: await ipc.hasEverStartedRun() });
        } catch {
          // Can't tell → don't invite (never nag on a broken read).
          set({ everRan: true });
        }
      },

      dismiss: () => set({ dismissed: true }),
      markUsed: () => set({ usedThisSession: true }),
      // A crew started through ANY path (launcher, draft bar, re-run) makes
      // the "you've never run a crew" invite a lie — retire it immediately.
      noteRunStarted: () => set({ everRan: true }),
    }),
    {
      name: "octo-first-run",
      partialize: (s) => ({ dismissed: s.dismissed }),
    },
  ),
);

/** Readiness for THE FLAGSHIP CREW specifically: Feature Factory's stages
 *  all run claude-* models on the api substrate, which resolve to the
 *  Anthropic provider — so only an ENABLED Anthropic provider with a
 *  configured key counts. A lone local provider (Ollama) or a key parked on
 *  a disabled provider would wave the user into a guaranteed stage-1
 *  failure — the exact first impression this check exists to prevent. */
export async function crewProviderReady(): Promise<boolean> {
  try {
    const [providers, settings] = await Promise.all([ipc.listProviders(), ipc.getSettings()]);
    const keys = (settings as { providerKeys?: Record<string, string> }).providerKeys ?? {};
    const anthropic = providers.find((p) => p.name === "anthropic");
    return !!anthropic && anthropic.enabled && (keys["anthropic"] ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tip } from "../lib/whatsNew";
import { playTour } from "../lib/tour/runner";
import { navigate } from "../lib/tour/surfaces";

/** The last version whose What's new the user has been shown. Persisted to
 *  localStorage (same class of app preference as the workspace and editor
 *  prefs). null ⇒ never recorded (a fresh install). */
interface WhatsNewPrefs {
  lastSeenVersion: string | null;
  setLastSeenVersion: (v: string) => void;
}

export const useWhatsNewPrefs = create<WhatsNewPrefs>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      setLastSeenVersion: (v) => set({ lastSeenVersion: v }),
    }),
    {
      name: "octo-whats-new",
      partialize: (s) => ({ lastSeenVersion: s.lastSeenVersion }),
      merge: (persisted, current) => {
        const v = (persisted as Partial<WhatsNewPrefs> | undefined)?.lastSeenVersion;
        return { ...current, lastSeenVersion: typeof v === "string" ? v : null };
      },
    },
  ),
);

/** `closed` — nothing on screen; `modal` — the What's new dialog;
 *  `touring` — the dialog stepped aside while a tip's "Show me" tour runs. */
export type WhatsNewPhase = "closed" | "modal" | "touring";

interface WhatsNewState {
  phase: WhatsNewPhase;
  tips: Tip[];
  index: number;
  open: (tips: Tip[], index?: number) => void;
  close: () => void;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  /** Run the current tip's tour, then come back to the dialog at the next tip
   *  (or the same one, when it was the last). */
  showMe: () => Promise<void>;
}

const clamp = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));

export const useWhatsNewStore = create<WhatsNewState>((set, get) => ({
  phase: "closed",
  tips: [],
  index: 0,
  open: (tips, index = 0) => {
    if (tips.length === 0) return;
    set({ phase: "modal", tips, index: clamp(index, tips.length) });
  },
  close: () => set({ phase: "closed", tips: [], index: 0 }),
  next: () => {
    const { index, tips } = get();
    if (index < tips.length - 1) set({ index: index + 1 });
  },
  back: () => {
    const { index } = get();
    if (index > 0) set({ index: index - 1 });
  },
  goTo: (index) => set({ index: clamp(index, get().tips.length) }),
  showMe: async () => {
    const { tips, index, phase } = get();
    const tip = tips[index];
    if (phase !== "modal" || !tip || tip.steps.length === 0) return;
    set({ phase: "touring" });
    await playTour(tip.steps, { mode: "interactive" });
    // Put the screen back: the tour may have opened Settings, the palette or a room.
    if (tip.steps.some((st) => st.open)) navigate({ kind: "close-overlays" });
    // Closed meanwhile (e.g. replaced) — don't resurrect the dialog.
    if (get().phase !== "touring") return;
    set({ phase: "modal", index: clamp(index + 1, tips.length) });
  },
}));

import { create } from "zustand";
import type { Pr } from "../lib/types";

/**
 * Pull requests per workspace and the "Open a pull request" composer.
 *
 * `byWorkspace[id]` is the branch's latest PR (`find_pr_for_branch`, polled
 * by App), `null` once a lookup found none, and absent while unknown — the
 * Review CTA only offers to open a PR on a known `null`. Creating one writes
 * it here straight away, so the ContextHeader chip doesn't wait for the poll.
 */
interface PrState {
  byWorkspace: Record<string, Pr | null>;
  setPr: (workspaceId: string, pr: Pr | null) => void;
  /** Workspace the composer is open for, or null when closed. */
  composerFor: string | null;
  openComposer: (workspaceId: string) => void;
  closeComposer: () => void;
}

export const usePrStore = create<PrState>((set) => ({
  byWorkspace: {},
  setPr: (workspaceId, pr) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: pr } })),
  composerFor: null,
  openComposer: (workspaceId) => set({ composerFor: workspaceId }),
  closeComposer: () => set({ composerFor: null }),
}));

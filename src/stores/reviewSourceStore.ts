/**
 * reviewSourceStore — Review's committed view (#851), per workspace.
 *
 * `committedByWs` holds the last `get_committed_diff` answer App fetched while
 * Review is on screen (absent = not fetched yet, null = unavailable).
 * `pickByWs` is the user's explicit Working tree / Since base choice; without
 * one, `resolveReviewSource` picks. Neither is persisted: a restart starts
 * from the default again.
 */
import { create } from "zustand";
import type { CommittedDiff } from "../lib/ipc";
import type { ReviewSource } from "../lib/reviewSource";

interface ReviewSourceState {
  committedByWs: Record<string, CommittedDiff | null>;
  pickByWs: Record<string, ReviewSource>;
  /** Store a fetched answer; a result equal to the current one is ignored,
   *  so the 3 s poll never re-renders Review for nothing. */
  setCommitted: (workspaceId: string, c: CommittedDiff | null) => void;
  pick: (workspaceId: string, source: ReviewSource) => void;
}

const same = (a: CommittedDiff | null | undefined, b: CommittedDiff | null) =>
  a === b ||
  (!!a && !!b && a.commits === b.commits && a.mergeBase === b.mergeBase && a.base === b.base && a.diff === b.diff);

export const useReviewSource = create<ReviewSourceState>((set, get) => ({
  committedByWs: {},
  pickByWs: {},
  setCommitted: (workspaceId, c) => {
    const cur = get().committedByWs;
    if (workspaceId in cur && same(cur[workspaceId], c)) return;
    set({ committedByWs: { ...cur, [workspaceId]: c } });
  },
  pick: (workspaceId, source) => set((s) => ({ pickByWs: { ...s.pickByWs, [workspaceId]: source } })),
}));

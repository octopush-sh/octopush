/**
 * reviewCommentsStore — the "Ask for a change" tray of Review (#956), per
 * workspace. `liveByWs` holds the hunk keys of the working-tree diff on
 * screen (`liveHunkKeys`), so the Companion can mark a comment outdated
 * without parsing the diff again. Session-local: nothing is persisted.
 * Sending them is `lib/sendReviewComments.ts`.
 */
import { create } from "zustand";
import type { ReviewComment } from "../lib/reviewComments";

interface ReviewCommentsState {
  byWs: Record<string, ReviewComment[]>;
  liveByWs: Record<string, Set<string>>;
  add: (workspaceId: string, c: Omit<ReviewComment, "id">) => void;
  remove: (workspaceId: string, id: string) => void;
  /** Empty the workspace's tray and hand back what it held. */
  take: (workspaceId: string) => ReviewComment[];
  setLive: (workspaceId: string, keys: Set<string>) => void;
}

const EMPTY: ReviewComment[] = [];
let seq = 0;

export const useReviewComments = create<ReviewCommentsState>((set, get) => ({
  byWs: {},
  liveByWs: {},
  add: (workspaceId, c) =>
    set((s) => ({
      byWs: { ...s.byWs, [workspaceId]: [...(s.byWs[workspaceId] ?? EMPTY), { ...c, id: `rc${++seq}` }] },
    })),
  remove: (workspaceId, id) =>
    set((s) => ({ byWs: { ...s.byWs, [workspaceId]: (s.byWs[workspaceId] ?? EMPTY).filter((c) => c.id !== id) } })),
  take: (workspaceId) => {
    const held = get().byWs[workspaceId] ?? EMPTY;
    set((s) => ({ byWs: { ...s.byWs, [workspaceId]: EMPTY } }));
    return held;
  },
  setLive: (workspaceId, keys) => {
    const cur = get().liveByWs[workspaceId];
    if (cur && cur.size === keys.size && [...keys].every((k) => cur.has(k))) return;
    set((s) => ({ liveByWs: { ...s.liveByWs, [workspaceId]: keys } }));
  },
}));

export const selectComments = (workspaceId: string) => (s: ReviewCommentsState) => s.byWs[workspaceId] ?? EMPTY;

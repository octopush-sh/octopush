/**
 * reviewCommentsStore — the "Ask for a change" tray of Review (#956), per
 * workspace. `liveByWs` holds the hunk keys of the working-tree diff on
 * screen (`liveHunkKeys`), so the Companion can mark a comment outdated
 * without parsing the diff again; `draftByWs` the comment being written.
 * Session-local: nothing is persisted.
 * Sending them is `lib/sendReviewComments.ts`.
 */
import { create } from "zustand";
import type { CommentDraft, ReviewComment } from "../lib/reviewComments";

type DraftUpdate = CommentDraft | null | ((d: CommentDraft | null) => CommentDraft | null);

interface ReviewCommentsState {
  byWs: Record<string, ReviewComment[]>;
  liveByWs: Record<string, Set<string>>;
  /** The open "Ask for a change" draft of each workspace (#1051): kept here,
   *  not in the diff view, so a half-typed note waits in its workspace while
   *  the view shows another, and is there again on the way back. */
  draftByWs: Record<string, CommentDraft>;
  setDraft: (workspaceId: string, next: DraftUpdate) => void;
  add: (workspaceId: string, c: Omit<ReviewComment, "id">) => void;
  remove: (workspaceId: string, id: string) => void;
  /** Empty the workspace's tray and hand back what it held. */
  take: (workspaceId: string) => ReviewComment[];
  /** Put taken comments back (a send that didn't go out), ahead of any added since. */
  restore: (workspaceId: string, comments: ReviewComment[]) => void;
  setLive: (workspaceId: string, keys: Set<string>) => void;
}

const EMPTY: ReviewComment[] = [];
let seq = 0;

export const useReviewComments = create<ReviewCommentsState>((set, get) => ({
  byWs: {},
  liveByWs: {},
  draftByWs: {},
  setDraft: (workspaceId, next) => {
    const cur = get().draftByWs[workspaceId] ?? null;
    const d = typeof next === "function" ? next(cur) : next;
    if (d === cur) return;
    set((s) => {
      const draftByWs = { ...s.draftByWs };
      if (d) draftByWs[workspaceId] = d;
      else delete draftByWs[workspaceId];
      return { draftByWs };
    });
  },
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
  restore: (workspaceId, comments) =>
    set((s) => ({ byWs: { ...s.byWs, [workspaceId]: [...comments, ...(s.byWs[workspaceId] ?? EMPTY)] } })),
  setLive: (workspaceId, keys) => {
    const cur = get().liveByWs[workspaceId];
    if (cur && cur.size === keys.size && [...keys].every((k) => cur.has(k))) return;
    set((s) => ({ liveByWs: { ...s.liveByWs, [workspaceId]: keys } }));
  },
}));

export const selectComments = (workspaceId: string) => (s: ReviewCommentsState) => s.byWs[workspaceId] ?? EMPTY;

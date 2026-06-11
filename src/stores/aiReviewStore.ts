import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ipc } from "../lib/ipc";
import { AI_REVIEW_SCHEMA, AI_REVIEW_SYSTEM, buildReviewPrompt, parseAiReview, type AiReviewResult } from "../lib/aiReview";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export type ReviewStatus = "idle" | "running" | "done" | "error";
export interface WsReview {
  status: ReviewStatus;
  result: AiReviewResult | null;
  diffHash: string | null;
  error: string | null;
}
const EMPTY: WsReview = { status: "idle", result: null, diffHash: null, error: null };

/** Stable FNV-1a hash of the diff string — used to detect "diff changed". */
export function diffHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface State {
  models: Record<string, string>;       // persisted (per workspace)
  reviews: Record<string, WsReview>;    // ephemeral
  runGen: Record<string, number>;       // ephemeral — per-ws run generation
  /** Panel collapse, per workspace. Ephemeral on purpose: it only needs to
   *  survive the mode-switch remount within a session, not a relaunch. */
  collapsed: Record<string, boolean>;
  modelFor: (ws: string) => string;
  reviewFor: (ws: string) => WsReview;
  collapsedFor: (ws: string) => boolean;
  setModel: (ws: string, model: string) => void;
  setCollapsed: (ws: string, collapsed: boolean) => void;
  clearError: (ws: string) => void;
  run: (ws: string, gitDiff: string) => Promise<void>;
}

export const useAiReview = create<State>()(
  persist(
    (set, get) => ({
      models: {},
      reviews: {},
      runGen: {},
      collapsed: {},
      modelFor: (ws) => get().models[ws] ?? DEFAULT_MODEL,
      reviewFor: (ws) => get().reviews[ws] ?? EMPTY,
      collapsedFor: (ws) => get().collapsed[ws] ?? true,
      setModel: (ws, model) => set((s) => ({ models: { ...s.models, [ws]: model } })),
      setCollapsed: (ws, collapsed) =>
        set((s) => ({ collapsed: { ...s.collapsed, [ws]: collapsed } })),
      clearError: (ws) =>
        set((s) => ({ reviews: { ...s.reviews, [ws]: { ...(s.reviews[ws] ?? EMPTY), error: null } } })),
      run: async (ws, gitDiff) => {
        const model = get().modelFor(ws);
        const gen = (get().runGen[ws] ?? 0) + 1;
        set((s) => ({
          runGen: { ...s.runGen, [ws]: gen },
          reviews: { ...s.reviews, [ws]: { ...EMPTY, status: "running" } },
        }));
        try {
          const res = await ipc.aiComplete(model, AI_REVIEW_SYSTEM, buildReviewPrompt(gitDiff), {
            workspaceId: ws,
            jsonSchema: AI_REVIEW_SCHEMA,
          });
          if (get().runGen[ws] !== gen) return; // a newer run superseded this one
          const result = parseAiReview(res.text);
          set((s) => ({
            reviews: { ...s.reviews, [ws]: { status: "done", result, diffHash: diffHash(gitDiff), error: null } },
          }));
        } catch (e) {
          if (get().runGen[ws] !== gen) return;
          set((s) => ({
            reviews: { ...s.reviews, [ws]: { status: "error", result: null, diffHash: null, error: e instanceof Error ? e.message : String(e) } },
          }));
        }
      },
    }),
    { name: "octo-ai-review", partialize: (s) => ({ models: s.models }) },
  ),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ipc } from "../lib/ipc";
import { pushToast } from "../components/Toasts";
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

/** One-shot guard for `reconcileAiReviewModels` — once per app session;
 *  re-armed when the catalog fetch itself fails. Declared BEFORE the store:
 *  persist's onRehydrateStorage callback fires synchronously inside
 *  `create()` below, and a later `let` would still be in its TDZ then. */
let reconciled = false;

/** Test hook — reset the one-shot guard between cases. */
export function _resetReconcileForTests(): void {
  reconciled = false;
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
    {
      name: "octo-ai-review",
      partialize: (s) => ({ models: s.models }),
      // Persisted model ids can outlive the provider catalog (a retired id
      // makes resolve_provider error on the next review) — reconcile them
      // against the live catalog once per session, right after rehydrate.
      // Deferred a microtask: this callback fires synchronously inside
      // create(), while the `useAiReview` const is still in its TDZ.
      onRehydrateStorage: () => () => {
        queueMicrotask(() => void reconcileAiReviewModels());
      },
    },
  ),
);

// ─── Persisted-model reconciliation ──────────────────────────────────────
// `models` persists raw ids to localStorage; the catalog they came from
// (Settings · Models & Providers — the same `list_providers` source the
// ModelPicker renders) can drop or disable them between sessions.

/** Map persisted per-workspace model ids that are no longer in the live
 *  catalog (retired, or their provider disabled) back to the default model,
 *  with a one-time info toast naming what was dropped. */
export async function reconcileAiReviewModels(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  const entries = Object.entries(useAiReview.getState().models).filter(
    ([, id]) => id !== DEFAULT_MODEL,
  );
  if (entries.length === 0) return;
  let providers;
  try {
    providers = await ipc.listProviders();
  } catch {
    reconciled = false; // catalog unavailable — let a later call retry
    return;
  }
  const valid = new Set(
    providers.filter((p) => p.enabled).flatMap((p) => p.models.map((m) => m.id)),
  );
  const stale = entries.filter(([, id]) => !valid.has(id));
  if (stale.length === 0) return;
  useAiReview.setState((s) => ({
    models: { ...s.models, ...Object.fromEntries(stale.map(([ws]) => [ws, DEFAULT_MODEL])) },
  }));
  const retired = [...new Set(stale.map(([, id]) => id))];
  pushToast({
    level: "info",
    title: "AI review model reset",
    body: `${retired.join(", ")} ${retired.length > 1 ? "are" : "is"} no longer in the model catalog — using ${DEFAULT_MODEL}.`,
  });
}

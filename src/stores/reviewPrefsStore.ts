import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

/** Clamp a split percent to the allowed [25,75] range and round to an integer,
 *  so persisted ratios and inline column widths stay tidy (no
 *  `width: 33.41666…%`). Shared by the write path and the rehydrate merge. */
export function clampSplit(pct: number): number {
  return Math.round(Math.max(25, Math.min(75, pct)));
}

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  /** Per-workspace "show gitignored files in the tree" pref, keyed by rootPath. */
  showIgnoredFiles: Record<string, boolean>;
  /** Markdown preview: open the rendered pane beside the editor for .md tabs. */
  mdPreview: boolean;
  /** Source-column width percent for the editor‖preview split (25..75). */
  mdPreviewSplit: number;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
  toggleShowIgnored: (rootPath: string) => void;
  toggleMdPreview: () => void;
  setMdPreviewSplit: (pct: number) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      showIgnoredFiles: {},
      mdPreview: true,
      mdPreviewSplit: 50,
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
      toggleShowIgnored: (rootPath) =>
        set((s) => {
          const next = { ...s.showIgnoredFiles };
          if (next[rootPath]) {
            delete next[rootPath];
          } else {
            next[rootPath] = true;
          }
          return { showIgnoredFiles: next };
        }),
      toggleMdPreview: () => set((s) => ({ mdPreview: !s.mdPreview })),
      setMdPreviewSplit: (pct) => set({ mdPreviewSplit: clampSplit(pct) }),
    }),
    {
      name: "octo-review-prefs",
      // Re-clamp the persisted split on load. The clamp on the write path can't
      // guard a stale or hand-edited storage value (or one written by a future
      // build with a different range); without this, a bad value would render
      // an editor or preview column at an extreme (near-0% or >100%) width.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ReviewPrefsState>;
        return {
          ...current,
          ...p,
          mdPreviewSplit:
            typeof p.mdPreviewSplit === "number"
              ? clampSplit(p.mdPreviewSplit)
              : current.mdPreviewSplit,
        };
      },
    },
  ),
);

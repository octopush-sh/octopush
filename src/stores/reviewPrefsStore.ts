import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

/** How a Markdown tab is laid out in REVIEW's editor view:
 *  `source` = editor only · `split` = editor ‖ rendered · `reading` = rendered only. */
export type MdView = "source" | "split" | "reading";

/** Cycle order for ⌥⌘M — the same left-to-right order as the toolbar control. */
const MD_VIEW_ORDER: readonly MdView[] = ["source", "split", "reading"];

export function isMdView(v: unknown): v is MdView {
  return typeof v === "string" && (MD_VIEW_ORDER as readonly string[]).includes(v);
}

/** Map the pre-3-state persisted pref (`mdPreview: boolean`) onto a view.
 *  Preview-off was "editor only"; preview-on was the fixed 50/50 split. */
function legacyMdView(mdPreview: unknown): MdView | null {
  if (typeof mdPreview !== "boolean") return null;
  return mdPreview ? "split" : "source";
}

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
  /** Markdown layout for .md tabs in the editor view. */
  mdView: MdView;
  /** Source-column width percent for the editor‖preview split (25..75). */
  mdPreviewSplit: number;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
  toggleShowIgnored: (rootPath: string) => void;
  setMdView: (v: MdView) => void;
  cycleMdView: () => void;
  setMdPreviewSplit: (pct: number) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      showIgnoredFiles: {},
      mdView: "split",
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
      setMdView: (mdView) => set({ mdView }),
      cycleMdView: () =>
        set((s) => {
          const i = MD_VIEW_ORDER.indexOf(s.mdView);
          return { mdView: MD_VIEW_ORDER[(i + 1) % MD_VIEW_ORDER.length] };
        }),
      setMdPreviewSplit: (pct) => set({ mdPreviewSplit: clampSplit(pct) }),
    }),
    {
      name: "octo-review-prefs",
      // Rehydrate defensively. Two things the write paths can't guard:
      //  · a stale, hand-edited or future-build `mdPreviewSplit` — re-clamped,
      //    otherwise a bad value renders a column at a near-0% / >100% width;
      //  · the legacy `mdPreview` boolean written before the three-state view —
      //    mapped once and then dropped, so it never lingers in storage.
      merge: (persisted, current) => {
        const {
          mdView,
          mdPreviewSplit,
          mdPreview,
          ...rest
        } = (persisted ?? {}) as Partial<ReviewPrefsState> & { mdPreview?: unknown };
        return {
          ...current,
          ...rest,
          mdView: isMdView(mdView) ? mdView : legacyMdView(mdPreview) ?? current.mdView,
          mdPreviewSplit:
            typeof mdPreviewSplit === "number"
              ? clampSplit(mdPreviewSplit)
              : current.mdPreviewSplit,
        };
      },
    },
  ),
);

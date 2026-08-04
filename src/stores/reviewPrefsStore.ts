import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

/** How a Markdown tab is laid out in REVIEW's editor view:
 *  `source` = editor only · `split` = editor ‖ rendered · `reading` = rendered only. */
export type MdView = "source" | "split" | "reading";

/** Cycle order for ⌥⌘M — the same left-to-right order as the toolbar control. */
const MD_VIEW_ORDER: readonly MdView[] = ["source", "split", "reading"];

const DEFAULT_MD_VIEW: MdView = "split";

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
      mdView: DEFAULT_MD_VIEW,
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
      version: 1,
      // v0 → v1: the `mdPreview` boolean became the three-state `mdView`.
      // This belongs in `migrate`, not only in `merge`, because zustand writes
      // the store back to storage ONLY after a real version migration — put it
      // in `merge` alone and the dead key lingers in localStorage until some
      // unrelated pref happens to be written.
      migrate: (persisted, version) => {
        if (version >= 1) return persisted;
        const { mdPreview, ...rest } = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...rest,
          mdView: isMdView(rest.mdView) ? rest.mdView : legacyMdView(mdPreview) ?? DEFAULT_MD_VIEW,
        };
      },
      // Rehydrate defensively — neither write path can guard a stale,
      // hand-edited or future-build value: a bad `mdPreviewSplit` would render
      // a column at a near-0% / >100% width, and an unknown `mdView` would
      // render no layout at all. Both fall back rather than propagate.
      merge: (persisted, current) => {
        const {
          mdView,
          mdPreviewSplit,
          mdPreview: _legacy,
          ...rest
        } = (persisted ?? {}) as Partial<ReviewPrefsState> & { mdPreview?: unknown };
        return {
          ...current,
          ...rest,
          mdView: isMdView(mdView) ? mdView : current.mdView,
          mdPreviewSplit:
            typeof mdPreviewSplit === "number"
              ? clampSplit(mdPreviewSplit)
              : current.mdPreviewSplit,
        };
      },
    },
  ),
);

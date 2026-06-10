import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  /** Per-workspace "show gitignored files in the tree" pref, keyed by rootPath. */
  showIgnoredFiles: Record<string, boolean>;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
  toggleShowIgnored: (rootPath: string) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      showIgnoredFiles: {},
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
      toggleShowIgnored: (rootPath) =>
        set((s) => ({
          showIgnoredFiles: {
            ...s.showIgnoredFiles,
            [rootPath]: !s.showIgnoredFiles[rootPath],
          },
        })),
    }),
    { name: "octo-review-prefs" },
  ),
);

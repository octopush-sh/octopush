import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
    }),
    { name: "octo-review-prefs" },
  ),
);

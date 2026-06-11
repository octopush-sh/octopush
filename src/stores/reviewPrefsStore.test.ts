import { describe, it, expect, beforeEach } from "vitest";
import { useReviewPrefs } from "./reviewPrefsStore";

describe("reviewPrefsStore", () => {
  beforeEach(() => { localStorage.clear(); useReviewPrefs.setState({ readingMode: "inline", ignoreWhitespace: false, showIgnoredFiles: {} }); });
  it("defaults to inline + whitespace-sensitive", () => {
    expect(useReviewPrefs.getState().readingMode).toBe("inline");
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(false);
  });
  it("toggles and persists reading mode", () => {
    useReviewPrefs.getState().setReadingMode("sbs");
    expect(useReviewPrefs.getState().readingMode).toBe("sbs");
    expect(localStorage.getItem("octo-review-prefs")).toContain("sbs");
  });
  it("toggles whitespace", () => {
    useReviewPrefs.getState().setIgnoreWhitespace(true);
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(true);
  });
  it("toggleShowIgnored flips the per-root flag without touching other roots", () => {
    useReviewPrefs.getState().toggleShowIgnored("/repo");
    expect(useReviewPrefs.getState().showIgnoredFiles["/repo"]).toBe(true);
    expect(useReviewPrefs.getState().showIgnoredFiles["/other"]).toBeUndefined();

    useReviewPrefs.getState().toggleShowIgnored("/repo");
    expect(useReviewPrefs.getState().showIgnoredFiles["/repo"]).toBeUndefined();
    expect("/repo" in useReviewPrefs.getState().showIgnoredFiles).toBe(false);
  });
});

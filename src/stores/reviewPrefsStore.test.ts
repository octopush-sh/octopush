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

describe("reviewPrefsStore — markdown preview", () => {
  beforeEach(() => {
    useReviewPrefs.setState({ mdPreview: true, mdPreviewSplit: 50 });
  });

  it("defaults mdPreview to true and mdPreviewSplit to 50", () => {
    expect(useReviewPrefs.getState().mdPreview).toBe(true);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });

  it("toggleMdPreview flips the flag", () => {
    useReviewPrefs.getState().toggleMdPreview();
    expect(useReviewPrefs.getState().mdPreview).toBe(false);
    useReviewPrefs.getState().toggleMdPreview();
    expect(useReviewPrefs.getState().mdPreview).toBe(true);
  });

  it("setMdPreviewSplit clamps to 25..75", () => {
    useReviewPrefs.getState().setMdPreviewSplit(40);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(40);
    useReviewPrefs.getState().setMdPreviewSplit(5);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(25);
    useReviewPrefs.getState().setMdPreviewSplit(95);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(75);
    // boundary values pass through unchanged
    useReviewPrefs.getState().setMdPreviewSplit(25);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(25);
    useReviewPrefs.getState().setMdPreviewSplit(75);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(75);
  });
});

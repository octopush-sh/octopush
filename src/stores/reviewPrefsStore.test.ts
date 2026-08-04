import { describe, it, expect, beforeEach } from "vitest";
import { useReviewPrefs, clampSplit } from "./reviewPrefsStore";

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

describe("reviewPrefsStore — markdown view", () => {
  beforeEach(() => {
    useReviewPrefs.setState({ mdView: "split", mdPreviewSplit: 50 });
  });

  it("defaults mdView to split and mdPreviewSplit to 50", () => {
    expect(useReviewPrefs.getState().mdView).toBe("split");
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });

  it("setMdView picks a layout directly", () => {
    useReviewPrefs.getState().setMdView("reading");
    expect(useReviewPrefs.getState().mdView).toBe("reading");
    useReviewPrefs.getState().setMdView("source");
    expect(useReviewPrefs.getState().mdView).toBe("source");
  });

  it("cycleMdView walks source → split → reading and wraps", () => {
    useReviewPrefs.getState().setMdView("source");
    useReviewPrefs.getState().cycleMdView();
    expect(useReviewPrefs.getState().mdView).toBe("split");
    useReviewPrefs.getState().cycleMdView();
    expect(useReviewPrefs.getState().mdView).toBe("reading");
    useReviewPrefs.getState().cycleMdView();
    expect(useReviewPrefs.getState().mdView).toBe("source");
  });

  it("setMdPreviewSplit clamps to 25..75 and rounds", () => {
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
    // a fractional drag value is rounded to an integer
    useReviewPrefs.getState().setMdPreviewSplit(33.4167);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(33);
  });
});

describe("clampSplit", () => {
  it("clamps to [25,75] and rounds to an integer", () => {
    expect(clampSplit(40)).toBe(40);
    expect(clampSplit(5)).toBe(25);
    expect(clampSplit(95)).toBe(75);
    expect(clampSplit(25)).toBe(25);
    expect(clampSplit(75)).toBe(75);
    expect(clampSplit(33.4167)).toBe(33);
    expect(clampSplit(33.6)).toBe(34);
    expect(clampSplit(-100)).toBe(25);
    expect(clampSplit(1000)).toBe(75);
  });
});

describe("reviewPrefsStore — rehydrate", () => {
  async function rehydrateWith(state: Record<string, unknown>, version = 0) {
    localStorage.setItem("octo-review-prefs", JSON.stringify({ state, version }));
    await useReviewPrefs.persist.rehydrate();
  }
  const stored = () => JSON.parse(localStorage.getItem("octo-review-prefs")!);

  beforeEach(() => {
    localStorage.clear();
    useReviewPrefs.setState({ mdView: "split", mdPreviewSplit: 50 });
  });

  it("re-clamps an out-of-range persisted mdPreviewSplit on load", async () => {
    await rehydrateWith({ mdPreviewSplit: 999 }, 1);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(75);
  });

  it("keeps a valid persisted mdView", async () => {
    await rehydrateWith({ mdView: "reading" }, 1);
    expect(useReviewPrefs.getState().mdView).toBe("reading");
  });

  // Seeded to "reading" so this can't pass by accident: an unknown value must
  // leave the live pref alone, not silently become the store's own default.
  it("keeps the current view when a v1 payload carries an unknown mdView", async () => {
    useReviewPrefs.setState({ mdView: "reading" });
    await rehydrateWith({ mdView: "sideways" }, 1);
    expect(useReviewPrefs.getState().mdView).toBe("reading");
  });

  it("normalises an unknown mdView to the default while migrating v0", async () => {
    useReviewPrefs.setState({ mdView: "reading" });
    await rehydrateWith({ mdView: "sideways" }, 0);
    expect(useReviewPrefs.getState().mdView).toBe("split");
  });

  // Migration from the pre-three-state pref: preview-off was "editor only",
  // preview-on was the fixed split.
  it("maps a legacy mdPreview:false onto the source view", async () => {
    await rehydrateWith({ mdPreview: false });
    expect(useReviewPrefs.getState().mdView).toBe("source");
    expect("mdPreview" in useReviewPrefs.getState()).toBe(false);
  });

  it("maps a legacy mdPreview:true onto the split view", async () => {
    useReviewPrefs.setState({ mdView: "reading" });
    await rehydrateWith({ mdPreview: true });
    expect(useReviewPrefs.getState().mdView).toBe("split");
    expect("mdPreview" in useReviewPrefs.getState()).toBe(false);
  });

  it("prefers an explicit mdView over a stale legacy mdPreview", async () => {
    await rehydrateWith({ mdView: "reading", mdPreview: false });
    expect(useReviewPrefs.getState().mdView).toBe("reading");
  });

  // In-memory correctness isn't enough: zustand only writes the store back
  // after a REAL version migration, so the dead key has to be dropped there
  // rather than in `merge` — otherwise it lingers in localStorage.
  it("rewrites storage without the legacy key", async () => {
    await rehydrateWith({ mdPreview: true, readingMode: "sbs" });
    expect(stored().version).toBe(1);
    expect(stored().state.mdPreview).toBeUndefined();
    expect(stored().state.mdView).toBe("split");
    expect(stored().state.readingMode).toBe("sbs");
  });
});

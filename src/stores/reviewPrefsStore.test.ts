import { describe, it, expect, beforeEach } from "vitest";
import { useReviewPrefs } from "./reviewPrefsStore";

function reset() {
  useReviewPrefs.setState({ mdPreview: true, mdPreviewSplit: 50 });
}

describe("reviewPrefsStore — markdown preview", () => {
  beforeEach(reset);

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
  });
});

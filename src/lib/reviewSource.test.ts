import { describe, it, expect } from "vitest";
import {
  DIFF_TRUNCATED_MARKER, baseName, commitCount, diffFileCount, isDiffTruncated, resolveReviewSource, sinceBaseLabel,
} from "./reviewSource";
import { emptyDiffCopy } from "../components/review/EmptyDiffState";

describe("resolveReviewSource (#851)", () => {
  it("is the working tree without commits ahead, whatever was picked", () => {
    expect(resolveReviewSource(null, false, 0)).toBe("working");
    expect(resolveReviewSource("committed", false, 0)).toBe("working");
  });
  it("defaults to the commits when the working tree is clean", () => {
    expect(resolveReviewSource(null, false, 3)).toBe("committed");
  });
  it("defaults to the working tree when both exist", () => {
    expect(resolveReviewSource(undefined, true, 3)).toBe("working");
  });
  it("honours an explicit pick", () => {
    expect(resolveReviewSource("committed", true, 3)).toBe("committed");
    expect(resolveReviewSource("working", false, 3)).toBe("working");
  });
  it("shows a picked turn (#1152), with or without commits ahead", () => {
    expect(resolveReviewSource("turn", true, 0, true)).toBe("turn");
    expect(resolveReviewSource("turn", false, 3, true)).toBe("turn");
  });
  it("falls back to the default when a turn pick has no turn to show", () => {
    expect(resolveReviewSource("turn", false, 3, false)).toBe("committed");
    expect(resolveReviewSource("turn", true, 3)).toBe("working");
    expect(resolveReviewSource("turn", false, 0)).toBe("working");
  });
});

describe("review source copy", () => {
  it("counts commits and files", () => {
    expect(commitCount(1)).toBe("1 commit");
    expect(sinceBaseLabel(3)).toBe("Since base · 3 commits");
    expect(diffFileCount("diff --git a/x b/x\n@@\n+1\ndiff --git a/y b/y\n")).toBe(2);
    expect(diffFileCount("")).toBe(0);
    expect(baseName(null)).toBe("the base branch");
    expect(baseName("dev")).toBe("dev");
  });

  it("the empty state names both cases", () => {
    const ctx = { source: "working" as const, commitsAhead: 0, base: "main", workingCount: 0 };
    expect(emptyDiffCopy(0, ctx)).toMatchObject({
      title: "Nothing to review.",
      body: expect.stringContaining("no commits since main"),
      showCommitted: false,
    });
    expect(emptyDiffCopy(0, { ...ctx, commitsAhead: 2 })).toMatchObject({
      title: "The working tree is clean.",
      showCommitted: true,
    });
    expect(emptyDiffCopy(1, { ...ctx, commitsAhead: 2 }).title).toBe("1 file staged.");
    expect(emptyDiffCopy(0, { ...ctx, source: "committed", commitsAhead: 2 }).body).toBe(
      "The 2 commits since main leave the code as it was.",
    );
  });
});

describe("review source follow-ups (#903)", () => {
  it("knows when the 1 MiB cap cut the diff, so its file count is a floor", () => {
    const cut = `diff --git a/x b/x\n@@\n+1\n\n${DIFF_TRUNCATED_MARKER}\n`;
    expect(isDiffTruncated(cut)).toBe(true);
    expect(diffFileCount(cut)).toBe(1);
    expect(isDiffTruncated("diff --git a/x b/x\n@@\n+1\n")).toBe(false);
    expect(isDiffTruncated("")).toBe(false);
  });

  it("says whitespace is ignored when an empty committed diff may be whitespace-only", () => {
    const ctx = { source: "committed" as const, commitsAhead: 2, base: "main", workingCount: 0, ignoreWhitespace: true };
    expect(emptyDiffCopy(0, ctx).body).toBe("With whitespace ignored, the 2 commits since main change nothing.");
    expect(emptyDiffCopy(0, { ...ctx, ignoreWhitespace: false }).body).toBe(
      "The 2 commits since main leave the code as it was.",
    );
  });

  it("a pinned default holds like a pick while the tree's dirtiness changes", () => {
    // Shown as Since base on a clean tree, then a crew touches a file.
    expect(resolveReviewSource("committed", true, 2)).toBe("committed");
  });
});

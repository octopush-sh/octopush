import { describe, it, expect } from "vitest";
import { baseName, commitCount, diffFileCount, resolveReviewSource, sinceBaseLabel } from "./reviewSource";
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

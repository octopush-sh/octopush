import { describe, it, expect } from "vitest";
import { parseFullDiff, hunkFingerprint } from "./diffParser";
import { commentAnchor, commentLocation, commentsMessage, isOutdated, liveHunkKeys, sendBackGate, type ReviewComment } from "./reviewComments";
import type { RunStage } from "./ipc";

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 line1
+added_2
+added_3
 line3
-deleted_4
 line5
`;
const [file] = parseFullDiff(DIFF);
const hunk = file.hunks[0];

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  ...commentAnchor("src/foo.ts", hunk, { from: 1, to: 2 }),
  note: "Name these constants.",
  ...over,
});

describe("commentAnchor", () => {
  it("anchors picked rows to the hunk's fingerprint, with their new-side lines and signs", () => {
    const a = commentAnchor("src/foo.ts", hunk, { from: 2, to: 1 });
    expect(a.fingerprint).toBe(hunkFingerprint(hunk));
    expect([a.startLine, a.endLine]).toEqual([2, 3]);
    expect(a.quote).toEqual(["+added_2", "+added_3"]);
  });
  it("takes the whole hunk without rows, and the old line for a deletion", () => {
    expect(commentAnchor("src/foo.ts", hunk).quote).toHaveLength(6);
    const del = commentAnchor("src/foo.ts", hunk, { from: 4, to: 4 });
    expect(del.quote).toEqual(["-deleted_4"]);
    expect(del.startLine).toBe(3);
  });
});

describe("commentLocation", () => {
  it("names one line or a range", () => {
    expect(commentLocation({ filePath: "a.ts", startLine: 3, endLine: 3 })).toBe("a.ts:3");
    expect(commentLocation({ filePath: "a.ts", startLine: 3, endLine: 9 })).toBe("a.ts:3–9");
  });
});

describe("isOutdated", () => {
  it("is outdated once its hunk is not in the diff; unknown is not outdated", () => {
    const c = comment();
    expect(isOutdated(c, liveHunkKeys([file]))).toBe(false);
    const edited = parseFullDiff(DIFF.replace("+added_3", "+added_three"));
    expect(isOutdated(c, liveHunkKeys(edited))).toBe(true);
    expect(isOutdated(c, liveHunkKeys([]))).toBe(true);
    expect(isOutdated(c, null)).toBe(false);
  });
});

describe("commentsMessage", () => {
  it("quotes each comment under its location, then its note", () => {
    const msg = commentsMessage([comment(), comment({ id: "c2", note: "  Drop this. " })], liveHunkKeys([]));
    expect(msg).toContain("left 2 comments");
    expect(msg).toContain("`src/foo.ts:2–3` (this hunk has changed since)\n> +added_2\n> +added_3\n\nName these constants.");
    expect(msg).toMatch(/Drop this\.$/);
  });
  it("says nothing about a change when the hunk is still there", () => {
    expect(commentsMessage([comment()], liveHunkKeys([file]))).not.toContain("changed since");
  });
});

describe("sendBackGate", () => {
  const stage = (over: Partial<RunStage>): RunStage =>
    ({ id: "s", position: 0, role: "implementer", status: "done", startedAt: "t", artifact: null,
      loopMode: null, loopTargetPosition: null, loopIterations: 0, loopMaxIterations: 3, ...over }) as RunStage;
  const impl = stage({ id: "impl", position: 0 });
  const review = stage({ id: "rev", position: 1, role: "reviewer", status: "awaiting_checkpoint", loopMode: "gated", loopTargetPosition: 0 });

  it("finds the stage it sends back to", () => {
    const g = sendBackGate(review, [impl, review]);
    expect(g?.target.id).toBe("impl");
    expect(g?.atCap).toBe(false);
  });
  it("is at its cap once the loop used every iteration", () => {
    expect(sendBackGate({ ...review, loopIterations: 3 }, [impl, review])?.atCap).toBe(true);
  });
  it("offers none for a budget-parked, auto-loop or plain checkpoint stage", () => {
    expect(sendBackGate({ ...review, startedAt: null }, [impl, review])).toBeNull();
    expect(sendBackGate({ ...review, loopMode: "auto" }, [impl, review])).toBeNull();
    expect(sendBackGate({ ...review, loopTargetPosition: null }, [impl, review])).toBeNull();
    expect(sendBackGate(null, [impl])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parseFullDiff, hunkFingerprint } from "./diffParser";
import {
  MAX_QUOTE_LINE_CHARS, MAX_QUOTE_LINES, commentAnchor, commentLocation, commentsMessage, isOutdated, liveHunkKeys,
  reanchorDraft, sendBackGate, stepPick, type CommentDraft, type ReviewComment,
} from "./reviewComments";
import type { RunStage } from "./ipc";

describe("stepPick", () => {
  it("starts a whole-hunk draft at its first row going down, its last going up", () => {
    expect(stepPick(undefined, 4, 1, false)).toEqual({ from: 0, to: 0 });
    expect(stepPick(undefined, 4, -1, true)).toEqual({ from: 3, to: 3 });
  });
  it("moves one row past the range's edge, and stays inside the hunk", () => {
    expect(stepPick({ from: 1, to: 2 }, 4, 1, false)).toEqual({ from: 3, to: 3 });
    expect(stepPick({ from: 2, to: 1 }, 4, -1, false)).toEqual({ from: 0, to: 0 });
    expect(stepPick({ from: 3, to: 3 }, 4, 1, false)).toEqual({ from: 3, to: 3 });
  });
  it("extends by moving the free end and keeping where the range began", () => {
    expect(stepPick({ from: 1, to: 1 }, 4, 1, true)).toEqual({ from: 1, to: 2 });
    expect(stepPick({ from: 1, to: 2 }, 4, -1, true)).toEqual({ from: 1, to: 1 });
    expect(stepPick({ from: 1, to: 1 }, 4, -1, true)).toEqual({ from: 1, to: 0 });
    expect(stepPick({ from: 1, to: 3 }, 4, 1, true)).toEqual({ from: 1, to: 3 });
  });
});

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

describe("commentAnchor: one side per range", () => {
  // Rows: 0 line1 (1/1) · 1 +added_2 (new 2) · 2 +added_3 (new 3) ·
  // 3 line3 (old 2/new 4) · 4 -deleted_4 (old 3) · 5 line5 (old 4/new 5).
  it("numbers a range that includes a removed row by its new-side rows only", () => {
    const a = commentAnchor("src/foo.ts", hunk, { from: 3, to: 5 });
    // Old line 3 (the removed row) must not become the start of a new-side range.
    expect([a.startLine, a.endLine]).toEqual([4, 5]);
    expect(a.removed).toBeUndefined();
    expect(a.quote).toEqual([" line3", "-deleted_4", " line5"]);
    expect(commentLocation(a)).toBe("src/foo.ts:4–5");
  });
  it("uses old-side lines, and says so, only when every picked row was removed", () => {
    const a = commentAnchor("src/foo.ts", hunk, { from: 4, to: 4 });
    expect([a.startLine, a.endLine, a.removed]).toEqual([3, 3, true]);
    expect(commentLocation(a)).toBe("src/foo.ts:3 (removed)");
    const whole = commentAnchor("src/foo.ts", hunk);
    expect([whole.startLine, whole.endLine, whole.removed]).toEqual([1, 5, undefined]);
  });
});

describe("commentAnchor: capped quote", () => {
  const body = Array.from({ length: 50 }, (_, i) => `+row_${i + 1}`).join("\n");
  const [bigFile] = parseFullDiff(`diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,50 @@\n${body}\n`);
  const big = bigFile.hunks[0];

  it("quotes at most MAX_QUOTE_LINES rows of a large hunk and counts the rest", () => {
    const a = commentAnchor("new.ts", big);
    expect(big.rows).toHaveLength(50);
    expect(a.quote).toHaveLength(MAX_QUOTE_LINES);
    expect(a.quote[0]).toBe("+row_1");
    expect(a.quoteCut).toBe(50 - MAX_QUOTE_LINES);
    // The place still names the whole range.
    expect([a.startLine, a.endLine]).toEqual([1, 50]);
  });
  it("says in the message how many lines were left out", () => {
    const msg = commentsMessage([{ id: "c", ...commentAnchor("new.ts", big), note: "Split this file." }], null);
    expect(msg).toContain(`> +row_${MAX_QUOTE_LINES}\n> … ${50 - MAX_QUOTE_LINES} more lines not quoted\n\nSplit this file.`);
    expect(msg).not.toContain(`row_${MAX_QUOTE_LINES + 1}`);
  });
  it("leaves a short quote whole, with nothing to say", () => {
    const a = commentAnchor("src/foo.ts", hunk);
    expect(a.quoteCut).toBeUndefined();
    expect(commentsMessage([{ id: "c", ...a, note: "n" }], null)).not.toContain("not quoted");
  });
  it("cuts an overlong line with an ellipsis", () => {
    const [f] = parseFullDiff(`diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-a\n+${"x".repeat(5000)}\n`);
    const a = commentAnchor("m.js", f.hunks[0], { from: 1, to: 1 });
    expect(a.quote[0]).toHaveLength(MAX_QUOTE_LINE_CHARS);
    expect(a.quote[0].endsWith("…")).toBe(true);
  });
});

describe("reanchorDraft", () => {
  const draft = (over: Partial<CommentDraft> = {}): CommentDraft => ({
    filePath: "src/foo.ts", hunkIdx: 0, rows: { from: 1, to: 2 },
    anchor: commentAnchor("src/foo.ts", hunk, { from: 1, to: 2 }), note: "Half a tho", stale: false, ...over,
  });
  const other = parseFullDiff(DIFF.replace("+added_3", "+added_three"))[0].hunks[0];

  it("is the same draft while its hunk is where it was", () => {
    const d = draft();
    expect(reanchorDraft(d, [file])).toBe(d);
  });
  it("follows its hunk to a new index", () => {
    const d = draft();
    expect(reanchorDraft(d, [{ ...file, hunks: [other, hunk] }])).toEqual({ ...d, hunkIdx: 1 });
  });
  it("stays open, as outdated, with its note and anchor when the hunk changed", () => {
    const d = draft({ hunkIdx: 1 });
    const next = reanchorDraft(d, [{ ...file, hunks: [other] }])!;
    expect(next).toMatchObject({ hunkIdx: 0, stale: true, note: "Half a tho", rows: undefined });
    expect(next.anchor).toBe(d.anchor);
    // Stable across further refetches of the same diff; fresh again if the hunk returns.
    expect(reanchorDraft(next, [{ ...file, hunks: [other] }])).toBe(next);
    expect(reanchorDraft(next, [file])).toMatchObject({ hunkIdx: 0, stale: false });
  });
  it("has nowhere to sit once its file left the diff", () => {
    expect(reanchorDraft(draft(), [])).toBeNull();
    expect(reanchorDraft(draft(), [{ ...file, hunks: [] }])).toBeNull();
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

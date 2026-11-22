import { describe, it, expect } from "vitest";
import { parseAiReview, buildReviewPrompt, fitReviewDiff, estimateTokens, partialReviewLine, WINDOW_TOO_SMALL } from "./aiReview";

const valid = JSON.stringify({
  summary: "Adds a word-diff",
  findings: [
    { severity: "high", category: "security", title: "Unescaped path", detail: "x", file: "a.rs", line: 12 },
    { severity: "low", category: "style", title: "Naming", detail: "", file: null, line: null },
  ],
});

describe("parseAiReview", () => {
  it("parses a clean JSON object", () => {
    const r = parseAiReview(valid);
    expect(r.summary).toBe("Adds a word-diff");
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({ severity: "high", category: "security", file: "a.rs", line: 12 });
    expect(r.findings[1].file).toBeNull();
  });
  it("strips ```json fences", () => {
    expect(parseAiReview("```json\n" + valid + "\n```").findings).toHaveLength(2);
  });
  it("ignores prose around the object", () => {
    expect(parseAiReview("Sure! Here:\n" + valid + "\nDone.").summary).toBe("Adds a word-diff");
  });
  it("coerces unknown severity to medium and unknown category to other", () => {
    const offSpec = JSON.stringify({ summary: "s", findings: [
      { severity: "huge", category: "security", title: "sev coerced" },
      { severity: "high", category: "nope", title: "cat coerced" },
      { severity: "high", category: "bug", title: "kept", detail: "d" },
    ]});
    const r = parseAiReview(offSpec);
    expect(r.findings).toHaveLength(3);
    expect(r.findings[0]).toMatchObject({ severity: "medium", category: "security", title: "sev coerced" });
    expect(r.findings[1]).toMatchObject({ severity: "high", category: "other", title: "cat coerced" });
    expect(r.findings[2]).toMatchObject({ severity: "high", category: "bug", title: "kept" });
  });
  it("drops only findings without a usable title", () => {
    const bad = JSON.stringify({ summary: "s", findings: [
      { severity: "high", category: "bug" },
      { severity: "high", category: "bug", title: "" },
      { severity: "high", category: "bug", title: "kept", detail: "d" },
    ]});
    const r = parseAiReview(bad);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe("kept");
  });
  it("accepts an empty findings array", () => {
    expect(parseAiReview(JSON.stringify({ summary: "clean", findings: [] })).findings).toEqual([]);
  });
  it("throws when there is no JSON object", () => {
    expect(() => parseAiReview("no json here")).toThrow();
  });
  it("ignores stray braces in prose before the object", () => {
    const r = parseAiReview("Here {are} my notes: " + valid + " {trailing}");
    expect(r.summary).toBe("Adds a word-diff");
    expect(r.findings).toHaveLength(2);
  });
  it("handles braces inside JSON string values", () => {
    const obj = JSON.stringify({ summary: "uses a map {k:v} literal", findings: [] });
    const r = parseAiReview("noise } " + obj + " more {");
    expect(r.summary).toBe("uses a map {k:v} literal");
  });
  it("parses fenced JSON whose string values contain ``` fences", () => {
    const tricky = JSON.stringify({
      summary: "s",
      findings: [{ severity: "low", category: "style", title: "t", detail: "use ```json fences```", file: null, line: null }],
    });
    const r = parseAiReview("```json\n" + tricky + "\n```");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].detail).toBe("use ```json fences```");
  });
});

describe("buildReviewPrompt", () => {
  it("embeds the diff", () => {
    expect(buildReviewPrompt("DIFF")).toContain("DIFF");
  });
  it("tells the model a cut diff is partial and names the files left out", () => {
    const p = buildReviewPrompt("DIFF", { readFiles: 1, totalFiles: 3, omitted: ["b.ts", "c.ts"], cutFile: null });
    expect(p).toContain("PARTIAL");
    expect(p).toContain("it was cut at a file boundary to fit your context window.");
    expect(p).toContain("Do not report code that is missing");
    expect(p).toContain("Files left out: b.ts, c.ts.");
    expect(p.endsWith("DIFF")).toBe(true);
  });
  it("words the note after what was actually cut", () => {
    const inside = buildReviewPrompt("DIFF", { readFiles: 1, totalFiles: 1, omitted: [], cutFile: "huge.ts" });
    expect(inside).toContain("it was cut inside huge.ts to fit your context window, so that file stops mid-way.");
    expect(inside).not.toContain("file boundary");
    expect(inside).not.toContain("too large to load in full");

    const cap = buildReviewPrompt("DIFF", { readFiles: 2, totalFiles: null, omitted: [], cutFile: null });
    expect(cap).toContain("the change was too large to load in full, so it stops mid-way.");
    expect(cap).not.toContain("context window");

    const both = buildReviewPrompt("DIFF", { readFiles: 2, totalFiles: null, omitted: ["c.ts"], cutFile: null });
    expect(both).toContain(
      "it was cut at a file boundary to fit your context window; the change was also too large to load in full, so more files may be missing than are listed.",
    );
  });
  it("caps the named files and counts the rest", () => {
    const omitted = Array.from({ length: 35 }, (_, i) => `f${i}.ts`);
    const p = buildReviewPrompt("DIFF", { readFiles: 1, totalFiles: 36, omitted, cutFile: null });
    expect(p).toContain("f29.ts (and 5 more)");
    expect(p).not.toContain("f30.ts");
  });
});

describe("fitReviewDiff (#943)", () => {
  const MARKER = "... diff truncated (too large to display fully) ...";
  const file = (name: string, lines: number) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n` + `+${"x".repeat(99)}\n`.repeat(lines);

  it("leaves a small diff untouched", () => {
    const d = file("a.ts", 10) + file("b.ts", 10);
    expect(fitReviewDiff(d, 200_000)).toEqual({ diff: d, partial: null });
    expect(fitReviewDiff(d, null)).toEqual({ diff: d, partial: null });
  });

  it("flags the 1 MiB marker and drops it from what the model reads", () => {
    const d = file("a.ts", 10) + file("b.ts", 3) + `\n${MARKER}\n`;
    const f = fitReviewDiff(d, 200_000);
    expect(f.diff).not.toContain(MARKER);
    expect(f.diff).toBe(file("a.ts", 10) + file("b.ts", 3));
    expect(f.partial).toEqual({ readFiles: 2, totalFiles: null, omitted: [], cutFile: null });
    expect(partialReviewLine(f.partial!)).toBe("Read the first 1 MB of the diff; the rest wasn't reviewed.");
  });

  it("cuts at a file boundary to fit the window", () => {
    // ~6.7k estimated tokens per file; 32k window leaves ~19k for the diff.
    const d = file("a.ts", 200) + file("b.ts", 200) + file("c.ts", 200) + file("d.ts", 200);
    const f = fitReviewDiff(d, 32_000);
    expect(f.diff).toBe(file("a.ts", 200) + file("b.ts", 200));
    expect(f.partial).toEqual({ readFiles: 2, totalFiles: 4, omitted: ["c.ts", "d.ts"], cutFile: null });
    expect(estimateTokens(f.diff)).toBeLessThan(32_000 - 8192);
    expect(partialReviewLine(f.partial!)).toBe("Read the first 2 of 4 files; the rest wasn't reviewed.");
  });

  it("a capped diff that also overflows the window can't name a total", () => {
    const d = file("a.ts", 200) + file("b.ts", 200) + file("c.ts", 200) + `\n${MARKER}\n`;
    const f = fitReviewDiff(d, 32_000);
    expect(f.partial).toEqual({ readFiles: 2, totalFiles: null, omitted: ["c.ts"], cutFile: null });
    expect(partialReviewLine(f.partial!)).toBe("Read the first 2 files; the rest wasn't reviewed.");
  });

  it("keeps the head of a first file too big for the window, cut at a line", () => {
    const d = file("src/huge.ts", 2000) + file("b.ts", 10);
    const f = fitReviewDiff(d, 32_000);
    expect(f.diff.startsWith("diff --git a/src/huge.ts b/src/huge.ts\n")).toBe(true);
    expect(f.diff.endsWith("\n")).toBe(true);
    expect(estimateTokens(f.diff)).toBeLessThan(32_000 - 8192);
    expect(f.partial).toEqual({ readFiles: 1, totalFiles: 2, omitted: ["b.ts"], cutFile: "src/huge.ts" });
    expect(partialReviewLine(f.partial!)).toBe("Read the first part of huge.ts, the first of 2 files; the rest wasn't reviewed.");
  });

  it("says a single file over the window was read only in part", () => {
    // ~200 KB lockfile (~67k estimated tokens) against a 64k window.
    const d = file("package-lock.json", 2000);
    const f = fitReviewDiff(d, 64_000);
    expect(f.diff.length).toBeLessThan(d.length);
    expect(f.partial).toEqual({ readFiles: 1, totalFiles: 1, omitted: [], cutFile: "package-lock.json" });
    expect(partialReviewLine(f.partial!)).toBe("Read the first part of package-lock.json; the rest wasn't reviewed.");
    expect(buildReviewPrompt(f.diff, f.partial)).toContain("cut inside package-lock.json");
  });

  it("refuses a window smaller than the reserves instead of sending an empty diff", () => {
    const d = file("a.ts", 200) + file("b.ts", 10);
    expect(() => fitReviewDiff(d, 10_000)).toThrow(WINDOW_TOO_SMALL);
    expect(() => fitReviewDiff(d, 8_192)).toThrow(WINDOW_TOO_SMALL);
  });

  it("names the count and the cut file when several files were read", () => {
    expect(partialReviewLine({ readFiles: 3, totalFiles: 5, omitted: ["d.ts", "e.ts"], cutFile: "lib/c.ts" })).toBe(
      "Read the first 3 of 5 files, the last one (c.ts) in part; the rest wasn't reviewed.",
    );
  });

  it("estimates tokens from UTF-8 bytes", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("é")).toBe(1); // 2 bytes
    expect(estimateTokens("€€€")).toBe(3); // 9 bytes
  });
});

// The schema-call path (G5 follow-up): the backend returns the forced tool's
// input serialized as raw JSON — parseAiReview must accept it unchanged, and
// the schema enums must stay in lockstep with the parser's coercion sets so
// guaranteed-shape responses never trip the coercion fallbacks.
import { AI_REVIEW_SCHEMA } from "./aiReview";

describe("AI_REVIEW_SCHEMA", () => {
  it("is a valid object schema requiring summary + findings", () => {
    expect(AI_REVIEW_SCHEMA.type).toBe("object");
    expect(AI_REVIEW_SCHEMA.required).toEqual(["summary", "findings"]);
  });
  it("enums match the parser's accepted severities and categories", () => {
    const item = AI_REVIEW_SCHEMA.properties.findings.items.properties;
    expect([...item.severity.enum]).toEqual(["high", "medium", "low"]);
    expect([...item.category.enum]).toEqual(["bug", "missing-test", "security", "style", "perf", "other"]);
    // Round-trip: a schema-shaped finding survives parseAiReview untouched.
    const finding = { severity: "high", category: "perf", title: "t", detail: "d", file: "a.ts", line: 7 };
    const parsed = parseAiReview(JSON.stringify({ summary: "s", findings: [finding] }));
    expect(parsed.findings[0]).toEqual(finding);
  });
});

import { describe, it, expect } from "vitest";
import { parseAiReview, buildReviewPrompt } from "./aiReview";

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
  it("drops invalid findings (bad severity/category/missing title)", () => {
    const bad = JSON.stringify({ summary: "s", findings: [
      { severity: "huge", category: "security", title: "x" },
      { severity: "high", category: "nope", title: "x" },
      { severity: "high", category: "bug" },
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
});

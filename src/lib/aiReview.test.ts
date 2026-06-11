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

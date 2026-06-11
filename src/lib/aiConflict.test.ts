import { describe, it, expect } from "vitest";
import { buildConflictPrompt, stripFences, CONFLICT_SYSTEM, MAX_CONFLICT_CHARS } from "./aiConflict";

describe("buildConflictPrompt", () => {
  it("includes the file name and the full content", () => {
    const content = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\nb\n";
    const p = buildConflictPrompt("src/app.ts", content);
    expect(p).toContain("src/app.ts");
    expect(p).toContain(content);
  });

  it("throws when the content exceeds the cap", () => {
    const huge = "x".repeat(MAX_CONFLICT_CHARS + 1);
    expect(() => buildConflictPrompt("big.ts", huge)).toThrow(/too large/i);
  });

  it("system prompt demands the complete merged file with no fences", () => {
    expect(CONFLICT_SYSTEM).toMatch(/merge conflict/i);
    expect(CONFLICT_SYSTEM).toMatch(/only/i);
  });
});

describe("stripFences", () => {
  it("removes a wrapping code fence with a language tag", () => {
    expect(stripFences("```ts\nconst a = 1;\nconst b = 2;\n```")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("removes a bare wrapping fence", () => {
    expect(stripFences("```\nhello\n```\n")).toBe("hello\n");
  });

  it("passes unfenced text through unchanged", () => {
    expect(stripFences("plain content\nline 2\n")).toBe("plain content\nline 2\n");
  });

  it("leaves interior fences alone", () => {
    const t = "doc\n```js\ncode\n```\nmore\n";
    expect(stripFences(t)).toBe(t);
  });
});

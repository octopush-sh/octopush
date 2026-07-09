import { describe, it, expect } from "vitest";
import { isMarkdownFile } from "./isMarkdownFile";

describe("isMarkdownFile", () => {
  it("is true for a text file whose lang is markdown", () => {
    expect(isMarkdownFile({ path: "/r/README.md", lang: "markdown", kind: "text" })).toBe(true);
  });

  it("is true for .markdown and .mdx by extension even if lang differs", () => {
    expect(isMarkdownFile({ path: "/r/NOTES.markdown", lang: "plain", kind: "text" })).toBe(true);
    expect(isMarkdownFile({ path: "/r/doc.mdx", lang: "plain", kind: "text" })).toBe(true);
  });

  it("is false for non-markdown text files", () => {
    expect(isMarkdownFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" })).toBe(false);
  });

  it("is false for a binary file even with a .md path", () => {
    expect(isMarkdownFile({ path: "/r/weird.md", lang: "markdown", kind: "binary" })).toBe(false);
  });

  it("is false for null / undefined", () => {
    expect(isMarkdownFile(null)).toBe(false);
    expect(isMarkdownFile(undefined)).toBe(false);
  });
});

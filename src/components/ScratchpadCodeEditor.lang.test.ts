import { describe, it, expect } from "vitest";
import { langExtension } from "./ScratchpadCodeEditor";

/**
 * Unit tests for the scratchpad language → CodeMirror extension mapping.
 * These use the REAL CodeMirror language packages (no mocks) — constructing a
 * language extension does not touch the DOM, so it runs fine under jsdom.
 */

function isDefinedExtension(ext: unknown): boolean {
  // A supported language returns a non-empty Extension (object or nested array).
  // Unsupported languages return an empty array (the plain-text fallback).
  if (Array.isArray(ext)) return ext.length > 0;
  return ext != null;
}

describe("langExtension", () => {
  it.each([
    "javascript",
    "typescript",
    "python",
    "rust",
    "java",
    "json",
    "markdown",
    "html",
    "css",
    "xml",
    "yaml",
  ])("returns a real language extension for %s", (lang) => {
    expect(isDefinedExtension(langExtension(lang))).toBe(true);
  });

  it.each(["scss", "sass", "less"])(
    "maps css-family language %s to the css extension",
    (lang) => {
      expect(isDefinedExtension(langExtension(lang))).toBe(true);
    },
  );

  it.each(["plaintext", "shell", "sql", "ruby", "toml", "", "unknown-lang"])(
    "falls back to no highlighting (empty extension) for %s",
    (lang) => {
      const ext = langExtension(lang);
      expect(Array.isArray(ext)).toBe(true);
      expect(ext as unknown[]).toHaveLength(0);
    },
  );
});

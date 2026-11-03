import { describe, it, expect } from "vitest";
import { scratchpadLang } from "./ScratchpadCodeEditor";
import { loadLanguageSupport } from "../lib/editorLanguages";

/**
 * Unit tests for the scratchpad language → grammar mapping. These load the
 * REAL CodeMirror language packages (no mocks) through the shared lazy loader —
 * constructing a language extension does not touch the DOM, so it runs fine
 * under jsdom.
 */

function isDefinedExtension(ext: unknown): boolean {
  // A supported language returns a non-empty Extension (object or nested array).
  // Unsupported languages return an empty array (the plain-text fallback).
  if (Array.isArray(ext)) return ext.length > 0;
  return ext != null;
}

describe("scratchpadLang", () => {
  it.each([
    ["javascript", "jsx"],
    ["typescript", "tsx"],
    ["python", "python"],
    ["rust", "rust"],
    ["java", "java"],
    ["json", "json"],
    ["markdown", "markdown"],
    ["html", "html"],
    ["css", "css"],
    ["xml", "xml"],
    ["yaml", "yaml"],
  ])("loads a real grammar for %s (%s)", async (lang, id) => {
    expect(scratchpadLang(lang)).toBe(id);
    expect(isDefinedExtension(await loadLanguageSupport(scratchpadLang(lang)))).toBe(true);
  });

  it.each(["scss", "sass", "less"])(
    "maps css-family language %s to the css grammar",
    (lang) => {
      expect(scratchpadLang(lang)).toBe("css");
    },
  );

  it.each(["plaintext", "shell", "sql", "ruby", "toml", "", "unknown-lang"])(
    "falls back to no highlighting (empty extension) for %s",
    async (lang) => {
      expect(scratchpadLang(lang)).toBe("plaintext");
      const ext = await loadLanguageSupport(scratchpadLang(lang));
      expect(Array.isArray(ext)).toBe(true);
      expect(ext as unknown[]).toHaveLength(0);
    },
  );
});

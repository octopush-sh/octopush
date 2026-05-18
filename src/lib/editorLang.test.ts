import { describe, it, expect } from "vitest";
import { langForExtension } from "./editorLang";

describe("langForExtension", () => {
  it.each([
    ["/a/b/foo.js",   "javascript"],
    ["/a/b/foo.jsx",  "javascript"],
    ["/a/b/foo.ts",   "javascript"],
    ["/a/b/foo.tsx",  "javascript"],
    ["/a/b/foo.mjs",  "javascript"],
    ["/a/b/foo.cjs",  "javascript"],
    ["/a/b/main.rs",  "rust"],
    ["/a/b/app.py",   "python"],
    ["/a/b/Main.java","java"],
    ["/a/b/pkg.json", "json"],
    ["/a/b/README.md","markdown"],
    ["/a/b/page.html","html"],
    ["/a/b/page.htm", "html"],
    ["/a/b/base.css", "css"],
    ["/a/b/main.scss","css"],
    ["/a/b/data.xml", "xml"],
    ["/a/b/icon.svg", "xml"],
    ["/a/b/ci.yaml",  "yaml"],
    ["/a/b/ci.yml",   "yaml"],
    ["/a/b/Makefile", "plaintext"],
    ["/a/b/no-ext",   "plaintext"],
  ])("langForExtension(%s) = %s", (path, expected) => {
    expect(langForExtension(path)).toBe(expected);
  });
});

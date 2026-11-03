import { describe, it, expect } from "vitest";
import { langForExtension, type LangId } from "./editorLang";
import { languageFor } from "./editorLanguages";

describe("langForExtension", () => {
  it.each([
    ["/a/b/foo.js",   "javascript"],
    ["/a/b/foo.mjs",  "javascript"],
    ["/a/b/foo.cjs",  "javascript"],
    ["/a/b/foo.jsx",  "jsx"],
    ["/a/b/foo.ts",   "typescript"],
    ["/a/b/foo.mts",  "typescript"],
    ["/a/b/foo.cts",  "typescript"],
    ["/a/b/foo.tsx",  "tsx"],
    ["/a/b/doc.mdx",  "markdown"],
    ["/a/b/tsconfig.jsonc", "json"],
    ["/a/b/App.vue",  "html"],
    ["/a/b/App.svelte","html"],
    ["/a/b/main.sass","sass"],
    ["/a/b/build.gradle","groovy"],
    ["/a/b/x.groovy", "groovy"],
    ["/a/b/build.gradle.kts","kotlin"],
    ["/a/b/x.scala",  "scala"],
    ["/a/b/x.dart",   "dart"],
    ["/a/b/x.proto",  "protobuf"],
    ["/a/b/x.hh",     "cpp"],
    ["/a/b/x.hxx",    "cpp"],
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
    ["/a/b/run.sh",   "shell"],
    ["/a/b/Cargo.toml","toml"],
    ["/a/b/main.go",  "go"],
    ["/a/b/q.sql",    "sql"],
    ["/a/b/Dockerfile","dockerfile"],
    ["/a/b/Dockerfile.dev","dockerfile"],
    ["/a/b/.env",     "properties"],
    ["/a/b/app.ini",  "properties"],
    ["/a/b/x.rb",     "ruby"],
    ["/a/b/x.swift",  "swift"],
    ["/a/b/x.c",      "c"],
    ["/a/b/x.hpp",    "cpp"],
    ["/a/b/x.cs",     "csharp"],
    ["/a/b/x.kt",     "kotlin"],
    ["/a/b/x.lua",    "lua"],
    ["/a/b/x.h",      "c"],
    // No grammar installed yet: these stay plain text (FEATURES.md §5).
    ["/a/b/Makefile", "plaintext"],
    ["/a/b/x.php",    "plaintext"],
    ["/a/b/main.tf",  "plaintext"],
    ["/a/b/x.hcl",    "plaintext"],
    ["/a/b/q.graphql","plaintext"],
    ["/a/b/no-ext",   "plaintext"],
  ])("langForExtension(%s) = %s", (path, expected) => {
    expect(langForExtension(path)).toBe(expected);
  });
});

/** Every node name in a parsed document. */
function nodeNames(lang: LangId, doc: string): string[] {
  const names: string[] = [];
  languageFor(lang)!.parser.parse(doc).iterate({ enter: (n) => { names.push(n.name); } });
  return names;
}

describe("JS/TS dialects", () => {
  // Generic arrow functions, angle-bracket casts and generic calls: in a .ts
  // file every one of these is TypeScript, never a JSX element.
  const GENERICS = [
    "const id = <T>(x: T): T => x;",
    "const n = <number>value;",
    "const m = new Map<string, Array<number>>();",
    "function first<T extends unknown[]>(xs: T): T[0] { return xs[0]; }",
  ].join("\n");

  it("parses a .ts file with generics without JSX nodes or errors", () => {
    const names = nodeNames(langForExtension("src/util.ts"), GENERICS);
    expect(names.filter((n) => n.startsWith("JSX"))).toEqual([]);
    expect(names).not.toContain("⚠");
    expect(names).toContain("TypeParamList");
  });

  it("still reads JSX in .tsx and .jsx files", () => {
    expect(nodeNames(langForExtension("App.tsx"), "const a = <div>{x as number}</div>;")).toContain("JSXElement");
    expect(nodeNames(langForExtension("App.jsx"), "const a = <div>{x}</div>;")).toContain("JSXElement");
  });
});

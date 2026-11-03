import { describe, it, expect } from "vitest";
import { highlightFile, highlightHunk, highlightLine, highlightLines, overlaySegments, rebuildSides, type DiffTok } from "./diffSyntax";
import { parseFullDiff } from "./diffParser";
import { langForExtension, type LangId } from "./editorLang";

const clsOf = (toks: DiffTok[], text: string) => toks.find((t) => t.text.includes(text))?.cls;
const joined = (toks: DiffTok[]) => toks.map((t) => t.text).join("");

// One fixture per language the editor claims (editorLang.ts). A Record, so a
// LangId added without a fixture here fails the typecheck.
const FIXTURES: Record<Exclude<LangId, "plaintext">, [path: string, line: string]> = {
  javascript: ["src/a.js", "const x = 1;"],
  jsx: ["src/A.jsx", "const a = <div>{x}</div>;"],
  typescript: ["src/a.ts", "const id = <T>(x: T): T => x;"],
  tsx: ["src/A.tsx", "const a: number = <b>{1}</b>;"],
  rust: ["src/main.rs", "fn main() { let x = 1; }"],
  python: ["app.py", "def f(x): return 1"],
  java: ["A.java", "public class A { int x = 1; }"],
  json: ["package.json", '{"name": "octopush"}'],
  markdown: ["README.md", "# Octopush"],
  html: ["index.html", '<div class="a">hi</div>'],
  css: ["a.css", ".a { color: red; }"],
  sass: ["a.sass", "// a comment"],
  scss: ["a.scss", "$gap: 4px;"],
  xml: ["a.xml", '<item id="1"/>'],
  yaml: ["ci.yml", "name: build"],
  shell: ["run.sh", 'if [ -f x ]; then echo "hi"; fi'],
  toml: ["Cargo.toml", 'name = "octopush"'],
  go: ["main.go", "func main() { return }"],
  sql: ["q.sql", "SELECT id FROM users WHERE id = 1;"],
  dockerfile: ["Dockerfile", "FROM node:20"],
  properties: ["app.properties", "# a comment"],
  ruby: ["a.rb", 'def hi; puts "hi"; end'],
  swift: ["a.swift", "let x = 1"],
  c: ["a.c", "int main(void) { return 0; }"],
  cpp: ["a.cpp", "int main() { return 0; }"],
  csharp: ["A.cs", "public class A { }"],
  kotlin: ["A.kt", "fun main() { val x = 1 }"],
  scala: ["A.scala", "object A { val x = 1 }"],
  groovy: ["build.gradle", "def version = '1.0'"],
  dart: ["a.dart", "void main() { var x = 1; }"],
  protobuf: ["a.proto", 'syntax = "proto3";'],
  lua: ["a.lua", "local x = 1"],
  php: ["a.php", "<?php echo $x; ?>"],
};

describe("highlightLine", () => {
  it.each(Object.entries(FIXTURES))("%s: a diff line gets highlight classes", (lang, [path, line]) => {
    expect(langForExtension(path)).toBe(lang);
    const toks = highlightLine(line, path);
    expect(toks.some((t) => t.cls.startsWith("tok-"))).toBe(true);
    expect(joined(toks)).toBe(line);
  });
  it("plaintext returns one unclassed token", () => {
    expect(highlightLine("just words here", "notes.txt")).toEqual([{ text: "just words here", cls: "" }]);
  });
});

describe("highlightLines", () => {
  it("colours every line of a block comment as a comment", () => {
    const toks = highlightLines(["/*", " * inside", " */", "int x = 1;"], "c");
    expect(clsOf(toks[1], "inside")).toBe("tok-cmt");
    expect(clsOf(toks[3], "int")).not.toBe("tok-cmt");
  });
  it("colours the inside of a Python docstring as a string", () => {
    const toks = highlightLines(['def f():', '    """', '    return not code', '    """'], "python");
    expect(clsOf(toks[2], "return")).toBe("tok-str");
  });
  it("round-trips each line, empty lines included", () => {
    const lines = ["const a = `x", "", "y`;", "let b = 2"];
    const toks = highlightLines(lines, "typescript");
    expect(toks.map(joined)).toEqual(lines);
  });
});

describe("highlightHunk", () => {
  it("reads context + added rows as one document", () => {
    const rows = [
      { kind: "context" as const, text: "/**", oldLine: 1, newLine: 1 },
      { kind: "add" as const, text: " * @param x the x", oldLine: null, newLine: 2 },
      { kind: "context" as const, text: " */", oldLine: 2, newLine: 3 },
    ];
    expect(clsOf(highlightHunk(rows, "A.java")[1], "@param")).toBe("tok-cmt");
  });
});

// A Java file whose only hunk starts inside a Javadoc block (the opener is
// two lines above it, outside the hunk's context).
const JAVA = [
  "package a;",
  "",
  "class A {",
  "  /**",
  "   * Adds two numbers.",
  "   * More words.",
  "   *",
  "   * @param x the first",
  "   * @param y the second",
  "   */",
  "  int add(int x, int y) {",
  "    return x + y;",
  "  }",
  "}",
  "",
].join("\n");
const JAVA_DIFF = [
  "diff --git a/A.java b/A.java",
  "--- a/A.java",
  "+++ b/A.java",
  "@@ -6,7 +6,7 @@ class A {",
  "    * More words.",
  "    *",
  "    * @param x the first",
  "-   * @param y the other",
  "+   * @param y the second",
  "    */",
  "   int add(int x, int y) {",
  "     return x + y;",
  "",
].join("\n");

describe("highlightFile", () => {
  const [file] = parseFullDiff(JAVA_DIFF);
  it("colours a hunk that starts inside a Javadoc as comment, on both sides", () => {
    const [toks] = highlightFile(file, JAVA);
    file.hunks[0].rows.forEach((r, i) => {
      if (r.text.includes("@param")) expect(clsOf(toks[i], "@param"), `${r.kind}: ${r.text}`).toBe("tok-cmt");
    });
    const body = file.hunks[0].rows.findIndex((r) => r.text.includes("int add"));
    expect(clsOf(toks[body], "int")).not.toBe("tok-cmt");
  });
  it("falls back to the hunk's own context when the file moved on", () => {
    const [toks] = highlightFile(file, "something else entirely\n");
    expect(toks).toHaveLength(file.hunks[0].rows.length);
    toks.forEach((t, i) => expect(joined(t)).toBe(file.hunks[0].rows[i].text));
  });
  it("leaves plaintext files unclassed", () => {
    const [txt] = parseFullDiff(JAVA_DIFF.replace(/A\.java/g, "notes.txt"));
    expect(highlightFile(txt, null)[0].every((t) => t.length === 1 && t[0].cls === "")).toBe(true);
  });
});

// A Go file whose hunk opens inside a raw string: only the full file says so.
const GO = [
  "package main",
  "",
  "const usage = `",
  "func not code",
  "`",
  "",
  "func main() {",
  "\tn := 42",
  "\tif n > 0 && true {",
  '\t\tprintln("hi", nil)',
  "\t}",
  "}",
  "",
].join("\n");
const GO_DIFF = [
  "diff --git a/main.go b/main.go",
  "--- a/main.go",
  "+++ b/main.go",
  "@@ -4,8 +4,8 @@ const usage = `",
  " func not code",
  " `",
  " ",
  " func main() {",
  "-\tn := 41",
  "+\tn := 42",
  " \tif n > 0 && true {",
  ' \t\tprintln("hi", nil)',
  " \t}",
  "",
].join("\n");

describe("highlightFile: Go", () => {
  const [file] = parseFullDiff(GO_DIFF);
  const rows = file.hunks[0].rows;
  const [toks] = highlightFile(file, GO);
  const row = (text: string) => toks[rows.findIndex((r) => r.text === text)];

  it("colours a hunk that opens inside a raw string as string", () => {
    expect(clsOf(row("func not code"), "func")).toBe("tok-str");
  });
  it("colours keywords, numbers, literals and strings from the Go tree", () => {
    expect(clsOf(row("func main() {"), "func")).toBe("tok-kw");
    expect(clsOf(row("\tn := 42"), "42")).toBe("tok-num");
    expect(clsOf(row("\tn := 41"), "41")).toBe("tok-num");
    expect(clsOf(row("\tif n > 0 && true {"), "if")).toBe("tok-kw");
    expect(clsOf(row("\tif n > 0 && true {"), "true")).toBe("tok-kw");
    expect(clsOf(row('\t\tprintln("hi", nil)'), '"hi"')).toBe("tok-str");
    expect(clsOf(row('\t\tprintln("hi", nil)'), "nil")).toBe("tok-cmt");
    expect(clsOf(row('\t\tprintln("hi", nil)'), "println")).toBe("tok-fn");
  });
  it("round-trips every row", () => {
    toks.forEach((t, i) => expect(joined(t)).toBe(rows[i].text));
  });
});

// Every tag the new grammars emit on a typical file maps to a diff class.
describe("highlightLines: new grammars style what they emit", () => {
  const SAMPLES: [LangId, string[], [text: string, cls: string][]][] = [
    ["go", ["// c", "type T struct{ N int }"], [["// c", "tok-cmt"], ["type", "tok-kw"], ["int", "tok-type"]]],
    ["cpp", ["#include <a.h>", "bool f() { return nullptr == 0; }"], [["#include", "tok-cmt"], ["bool", "tok-type"], ["return", "tok-kw"], ["nullptr", "tok-cmt"], ["0", "tok-num"]]],
    ["c", ["/* c */ int x = 'a';"], [["/* c */", "tok-cmt"], ["int", "tok-type"]]],
    ["sql", ["SELECT 'a', 1 FROM t; -- c"], [["SELECT", "tok-kw"], ["'a'", "tok-str"], ["1", "tok-num"], ["-- c", "tok-cmt"]]],
    ["scss", ["@mixin m { .card { color: red; } }"], [["@mixin", "tok-kw"], ["card", "tok-type"], ["color", "tok-var"]]],
    ["sass", ["@mixin m", "  color: red"], [["@mixin", "tok-kw"], ["color", "tok-var"]]],
    ["php", ["<?php", "function f() { return 'a' . 1; }"], [["function", "tok-kw"], ["'a'", "tok-str"], ["1", "tok-num"]]],
  ];
  it.each(SAMPLES)("%s", (lang, lines, expected) => {
    const toks = highlightLines(lines, lang).flat();
    for (const [text, cls] of expected) expect(clsOf(toks, text), text).toBe(cls);
  });
});

describe("rebuildSides", () => {
  it("rebuilds the old side by reverse-applying the hunks", () => {
    const now = "a\nb\nNEW\nd\ne\nf\ng\nh\ni\nj\n";
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -2,3 +2,3 @@",
      " b",
      "-c",
      "+NEW",
      " d",
      "@@ -8,1 +7,0 @@",
      "-gone",
      "",
    ].join("\n");
    const [file] = parseFullDiff(diff);
    const sides = rebuildSides(file, now)!;
    expect(sides.new).toEqual(["a", "b", "NEW", "d", "e", "f", "g"]);
    expect(sides.old).toEqual(["a", "b", "c", "d", "e", "f", "g", "gone"]);
  });
  it("returns null when the content doesn't match the diff", () => {
    const [file] = parseFullDiff(JAVA_DIFF);
    expect(rebuildSides(file, "package a;\n")).toBeNull();
  });
});

describe("overlaySegments", () => {
  it("keeps syntax classes and adds the word-diff mark", () => {
    const toks = highlightLine("return 42", "a.ts");
    const out = overlaySegments(toks, [{ kind: "equal", text: "return " }, { kind: "add", text: "42" }]);
    expect(joined(out)).toBe("return 42");
    expect(out.find((t) => t.text === "42")?.cls).toBe("tok-num wd-add");
    expect(out.find((t) => t.text === "return")?.cls).toBe("tok-kw");
  });
});

import { describe, it, expect } from "vitest";
import {
  chooseDefinition,
  extensionOf,
  isTestPath,
  isVendorPath,
  rankDefinitionHits,
  type DefinitionCandidate,
} from "./definitionSearch";
import type { SearchHit } from "./types";

const hit = (file: string, line: number, preview: string): SearchHit => ({
  file,
  line,
  col: Math.max(1, preview.indexOf("parse") + 1),
  preview,
});

describe("path helpers", () => {
  it("reads extensions, ignoring dotfiles and directories", () => {
    expect(extensionOf("src/lib/ipc.ts")).toBe("ts");
    expect(extensionOf("src/App.test.tsx")).toBe("tsx");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("recognises test files by folder and by suffix", () => {
    expect(isTestPath("src/lib/ipc.test.ts")).toBe(true);
    expect(isTestPath("tests/parser.rs")).toBe(true);
    expect(isTestPath("src/__tests__/x.ts")).toBe(true);
    expect(isTestPath("python/test_parser.py")).toBe(true);
    expect(isTestPath("src/lib/ipc.ts")).toBe(false);
    // "latest" must not read as "test".
    expect(isTestPath("src/latest/index.ts")).toBe(false);
  });

  it("recognises vendored and built output", () => {
    expect(isVendorPath("node_modules/cmdk/dist/index.js")).toBe(true);
    expect(isVendorPath("src-tauri/target/debug/build.rs")).toBe(true);
    expect(isVendorPath("src/target.ts")).toBe(false);
  });
});

describe("rankDefinitionHits", () => {
  it("drops mentions that aren't definitions", () => {
    const hits = [
      hit("src/a.ts", 3, "  const out = parse(input);"),
      hit("src/a.ts", 9, "  return parse(x);"),
      hit("src/parser.ts", 12, "export function parse(input: string) {"),
    ];
    const ranked = rankDefinitionHits(hits, "parse");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ file: "src/parser.ts", line: 12 });
  });

  it("trims the preview so the picker isn't full of indentation", () => {
    const ranked = rankDefinitionHits(
      [hit("src/parser.ts", 1, "    function parse() {")],
      "parse",
    );
    expect(ranked[0].preview).toBe("function parse() {");
  });

  it("prefers a same-language neighbour over a foreign file", () => {
    const hits = [
      hit("docs/parse.py", 4, "def parse(x):"),
      hit("src/parser.ts", 12, "export function parse(input: string) {"),
    ];
    const ranked = rankDefinitionHits(hits, "parse", { fromFile: "src/app.ts" });
    expect(ranked[0].file).toBe("src/parser.ts");
  });

  it("pushes tests and vendored copies below real source", () => {
    const hits = [
      hit("src/parser.test.ts", 2, "function parse() {"),
      hit("node_modules/p/index.ts", 5, "function parse() {"),
      hit("src/parser.ts", 12, "function parse() {"),
    ];
    const ranked = rankDefinitionHits(hits, "parse");
    expect(ranked.map((c) => c.file)).toEqual([
      "src/parser.ts",
      "src/parser.test.ts",
      "node_modules/p/index.ts",
    ]);
  });

  it("drops the exact line the reader asked from", () => {
    // The clicked line can itself look like a definition (`parse = parse`);
    // returning it would jump to where the caret already is.
    const hits = [hit("src/a.ts", 7, "parse = other;")];
    expect(
      rankDefinitionHits(hits, "parse", { fromFile: "src/a.ts", fromLine: 7 }),
    ).toEqual([]);
    expect(
      rankDefinitionHits(hits, "parse", { fromFile: "src/a.ts", fromLine: 8 }),
    ).toHaveLength(1);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      hit(`src/f${i}.ts`, 1, "function parse() {"),
    );
    expect(rankDefinitionHits(many, "parse", { limit: 5 })).toHaveLength(5);
  });
});

describe("chooseDefinition", () => {
  const c = (file: string, score: number): DefinitionCandidate => ({
    file,
    line: 1,
    preview: "",
    score,
  });

  it("reports nothing when no candidate survived", () => {
    expect(chooseDefinition([])).toEqual({ kind: "none" });
  });

  it("jumps when there is only one candidate", () => {
    expect(chooseDefinition([c("a.ts", 40)])).toEqual({
      kind: "jump",
      candidate: c("a.ts", 40),
    });
  });

  it("jumps when the winner is a full tier ahead", () => {
    const choice = chooseDefinition([c("a.ts", 100), c("b.ts", 40)]);
    expect(choice.kind).toBe("jump");
  });

  it("asks when the top two are close", () => {
    // Two declarations of the same name in two source files: guessing here is
    // how a reader ends up in the wrong file with no idea why.
    const choice = chooseDefinition([c("a.ts", 112), c("b.ts", 100)]);
    expect(choice).toEqual({
      kind: "choose",
      candidates: [c("a.ts", 112), c("b.ts", 100)],
    });
  });
});

import { describe, it, expect, vi } from "vitest";

// Every grammar module records when it is first evaluated, so the test can
// tell an import of `editorLanguages` from a request for a language.
const imported = vi.hoisted(() => new Set<string>());
vi.mock("@codemirror/lang-javascript", (orig) => { imported.add("lang-javascript"); return orig(); });
vi.mock("@codemirror/lang-rust", (orig) => { imported.add("lang-rust"); return orig(); });
vi.mock("@codemirror/lang-python", (orig) => { imported.add("lang-python"); return orig(); });
vi.mock("@codemirror/lang-java", (orig) => { imported.add("lang-java"); return orig(); });
vi.mock("@codemirror/lang-json", (orig) => { imported.add("lang-json"); return orig(); });
vi.mock("@codemirror/lang-markdown", (orig) => { imported.add("lang-markdown"); return orig(); });
vi.mock("@codemirror/lang-html", (orig) => { imported.add("lang-html"); return orig(); });
vi.mock("@codemirror/lang-css", (orig) => { imported.add("lang-css"); return orig(); });
vi.mock("@codemirror/lang-xml", (orig) => { imported.add("lang-xml"); return orig(); });
vi.mock("@codemirror/lang-yaml", (orig) => { imported.add("lang-yaml"); return orig(); });
vi.mock("@codemirror/lang-go", (orig) => { imported.add("lang-go"); return orig(); });
vi.mock("@codemirror/lang-cpp", (orig) => { imported.add("lang-cpp"); return orig(); });
vi.mock("@codemirror/lang-sql", (orig) => { imported.add("lang-sql"); return orig(); });
vi.mock("@codemirror/lang-sass", (orig) => { imported.add("lang-sass"); return orig(); });
vi.mock("@codemirror/lang-php", (orig) => { imported.add("lang-php"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/shell", (orig) => { imported.add("mode/shell"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/toml", (orig) => { imported.add("mode/toml"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/dockerfile", (orig) => { imported.add("mode/dockerfile"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/properties", (orig) => { imported.add("mode/properties"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/ruby", (orig) => { imported.add("mode/ruby"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/swift", (orig) => { imported.add("mode/swift"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/clike", (orig) => { imported.add("mode/clike"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/groovy", (orig) => { imported.add("mode/groovy"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/protobuf", (orig) => { imported.add("mode/protobuf"); return orig(); });
vi.mock("@codemirror/legacy-modes/mode/lua", (orig) => { imported.add("mode/lua"); return orig(); });

import { loadLanguage, loadLanguageSupport, loadedLanguage, loadedLanguageSupport } from "./editorLanguages";
import { diffGrammarReady, highlightLine, loadDiffGrammar } from "./diffSyntax";

// In order: each case builds on the grammars the ones before it loaded.
describe("lazy grammars", () => {
  it("importing editorLanguages (and diffSyntax) pulls in no grammar", () => {
    expect([...imported]).toEqual([]);
    expect(loadedLanguage("go")).toBeUndefined();
    expect(loadedLanguageSupport("go")).toBeUndefined();
  });

  it("loads only the grammar that was asked for", async () => {
    const go = await loadLanguage("go");
    expect(go).not.toBeNull();
    expect([...imported]).toEqual(["lang-go"]);
    expect(loadedLanguage("go")).toBe(go);
    expect(loadedLanguage("rust")).toBeUndefined();
  });

  it("memoises per language", async () => {
    const first = await loadLanguage("go");
    expect(await loadLanguage("go")).toBe(first);
    expect(await loadLanguageSupport("go")).toBe(loadedLanguageSupport("go"));
  });

  it("reads C with the C++ grammar", async () => {
    const c = await loadLanguage("c");
    expect([...imported]).toContain("lang-cpp");
    expect(loadedLanguage("cpp")).toBe(c);
  });

  it("stream modes load their own module", async () => {
    const kotlin = await loadLanguage("kotlin");
    expect(kotlin?.parser).toBeDefined();
    expect([...imported]).toContain("mode/clike");
    expect([...imported]).not.toContain("mode/shell");
  });

  it("plain text needs no load", async () => {
    expect(loadedLanguage("plaintext")).toBeNull();
    expect(loadedLanguageSupport("plaintext")).toEqual([]);
    expect(await loadLanguage("plaintext")).toBeNull();
    expect(await loadLanguageSupport("plaintext")).toEqual([]);
  });

  it("a diff reads as plain text until its grammar lands, coloured from then on", async () => {
    const line = "fn main() { let x = 1; }";
    expect(diffGrammarReady("src/main.rs")).toBe(false);
    expect(highlightLine(line, "src/main.rs")).toEqual([{ text: line, cls: "" }]);

    await loadDiffGrammar("src/main.rs");
    expect(diffGrammarReady("src/main.rs")).toBe(true);
    // Warm cache: synchronous, no await.
    expect(highlightLine(line, "src/main.rs").some((t) => t.cls.startsWith("tok-"))).toBe(true);
    expect(diffGrammarReady("notes.txt")).toBe(true);
  });
});

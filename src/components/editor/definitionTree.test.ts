import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { languageSupport } from "../../lib/editorLanguages";
import type { LangId } from "../../lib/editorLang";
import { classifyClick, classifySite, hasDefinitionTree } from "./definitionTree";

function stateFor(lang: LangId, doc: string) {
  return EditorState.create({ doc, extensions: [languageSupport(lang)] });
}

/** The `nth` whole-word occurrence of `name` in `doc`, as a range. */
function rangeOf(doc: string, name: string, nth = 0) {
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  const hits = [...doc.matchAll(re)];
  const from = hits[nth].index!;
  return { name, from, to: from + name.length };
}

describe("classifyClick", () => {
  const keywords: [LangId, string, string][] = [
    ["java", "public static Integer wait() { return 1; }", "static"],
    ["java", "class A { int count; }", "int"],
    ["java", "class A { void run() {} }", "void"],
    ["javascript", "const total = 1;", "const"],
    ["javascript", "export function run() {}", "function"],
    ["rust", "impl Display for Foo {}", "impl"],
    ["rust", "fn f(x: u32) -> u32 { x }", "u32"],
    ["python", "def run(self):\n    return 1\n", "def"],
    // Literals and TypeScript's primitive types are part of the language too.
    ["javascript", "const ok = true;", "true"],
    ["javascript", "const ok = false;", "false"],
    ["java", "class A { boolean f() { return true; } }", "true"],
    ["python", "ok = True\n", "True"],
    ["python", "ok = False\n", "False"],
    ["rust", "fn f() -> bool { false }", "false"],
    ...["boolean", "any", "string", "number", "unknown", "never", "object", "bigint", "symbol", "undefined"].map(
      (t): [LangId, string, string] => ["javascript", `let x: ${t};`, t],
    ),
    ["javascript", "let x: string | null = null;", "null"],
    ["javascript", "function f(): void {}", "void"],
  ];
  for (const [lang, doc, word] of keywords) {
    it(`${lang}: \`${word}\` is a keyword`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word))).toBe("keyword");
    });
  }

  const identifiers: [LangId, string, string][] = [
    ["java", "class A { public static Integer wait() { return 1; } }", "Integer"],
    ["java", "class A { String name; }", "String"],
    ["javascript", "const type = kind();", "type"],
    ["python", "final = compute()\n", "final"],
    ["rust", "struct Point { x: u32 }", "Point"],
    // A TypeScript type that merely sounds primitive is still a name.
    ["javascript", "let x: Foo;", "Foo"],
    ["javascript", "let x: String;", "String"],
  ];
  for (const [lang, doc, word] of identifiers) {
    it(`${lang}: \`${word}\` is an ordinary identifier`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word))).toBe("identifier");
    });
  }

  // An identifier node whose text happens to equal its node name is still a
  // name: parser code declares types called `Identifier` or `Definition`.
  const namedLikeNodes: [LangId, string, string, number][] = [
    ["java", "class Definition { }", "Definition", 0],
    ["java", "class A { int Identifier = 0; int f() { return Identifier; } }", "Identifier", 1],
    ["java", "class A { TypeName t; }", "TypeName", 0],
    ["rust", "struct TypeIdentifier;", "TypeIdentifier", 0],
    ["rust", "fn f() { let Identifier = 1; Identifier; }", "Identifier", 1],
    ["javascript", "const VariableName = 1; VariableName;", "VariableName", 1],
    ["javascript", "const VariableDefinition = 1;", "VariableDefinition", 0],
    ["python", "VariableName = 1\nprint(VariableName)\n", "VariableName", 1],
  ];
  for (const [lang, doc, word, nth] of namedLikeNodes) {
    it(`${lang}: \`${word}\` named like its own node is an identifier`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word, nth))).toBe("identifier");
    });
  }

  it("has no opinion where the language has no Lezer grammar", () => {
    const doc = "const limit = 5";
    expect(hasDefinitionTree("go")).toBe(false);
    expect(classifyClick(stateFor("go", doc), "go", rangeOf(doc, "const"))).toBe("unknown");
  });
});

describe("classifySite", () => {
  const declarations: [LangId, string, string, number?][] = [
    ["java", "class A { public static Integer esperaSugerida() { return 1; } }", "esperaSugerida"],
    ["java", "class A { private final Repo repo; }", "repo"],
    ["java", "class A { @Bean public RestTemplate restTemplate() { return null; } }", "restTemplate"],
    ["javascript", "const total = 1;", "total"],
    ["javascript", "class A { render(props) { return 1; } }", "render"],
    ["javascript", "type Parser = (x: string) => Ast;", "Parser"],
    ["rust", "pub fn parse(input: &str) {}", "parse"],
    ["rust", "pub struct Point { x: u32 }", "Point"],
    ["rust", "fn f() { let mut total = 0; }", "total"],
    ["python", "def parse(self, input):\n    pass\n", "parse"],
    ["python", "total = count\n", "total"],
  ];
  for (const [lang, doc, name, nth] of declarations) {
    it(`${lang}: declares ${name} in "${doc.split("\n")[0]}"`, () => {
      expect(classifySite(stateFor(lang, doc), lang, rangeOf(doc, name, nth))).toBe("declaration");
    });
  }

  const others: [LangId, string, string, number?][] = [
    // The owner's case: the return type is not what the method declares.
    ["java", "class A { public static Integer esperaSugerida() { return 1; } }", "Integer"],
    ["javascript", "let run;\nrun = 5;\n", "run", 1],
    ["rust", "impl Display for Foo {}", "Display"],
    ["python", "total = count\n", "count"],
  ];
  for (const [lang, doc, name, nth] of others) {
    it(`${lang}: vetoes ${name} in "${doc.split("\n").join(" ⏎ ")}"`, () => {
      expect(classifySite(stateFor(lang, doc), lang, rangeOf(doc, name, nth))).toBe("other");
    });
  }

  it("has no opinion where the language has no Lezer grammar", () => {
    const doc = "var count int";
    expect(classifySite(stateFor("go", doc), "go", rangeOf(doc, "count"))).toBe("unknown");
  });
});

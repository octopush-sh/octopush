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
      (t): [LangId, string, string] => ["typescript", `let x: ${t};`, t],
    ),
    ["typescript", "let x: string | null = null;", "null"],
    ["typescript", "function f(): void {}", "void"],
    ["tsx", "const total: number = 1;", "number"],
    ["jsx", "export function run() {}", "function"],
    // Go: keywords, literals, predeclared types and builtins with nodes of their own.
    ["go", "package main\nfunc run() {}\n", "func"],
    ["go", "package main\nfunc run() { for { break } }\n", "for"],
    ["go", "package main\nvar ok = true\n", "true"],
    ["go", "package main\nvar ok = false\n", "false"],
    ["go", "package main\nvar p *T = nil\n", "nil"],
    ["go", "package main\nvar n int\n", "int"],
    ["go", "package main\nfunc f(s string) error { return nil }\n", "string"],
    ["go", "package main\nconst (\n\tA = iota\n)\n", "iota"],
    ["go", "package main\nvar m = make(map[string]int)\n", "make"],
    // C and C++: the same grammar.
    ["c", "static int count;", "static"],
    ["c", "int main(void) { return 0; }", "void"],
    ["c", "unsigned long n;", "unsigned"],
    ["c", "void f(void) { if (p == NULL) return; }", "NULL"],
    ["c", "size_t n;", "size_t"],
    ["cpp", "class A { public: int f(); };", "public"],
    ["cpp", "class A { public: int f(); };", "class"],
    ["cpp", "struct B : A { void f() override; };", "override"],
    ["cpp", "bool f() { return true; }", "true"],
    ["cpp", "bool f() { return false; }", "bool"],
    ["cpp", "void f() { auto p = nullptr; }", "nullptr"],
    ["cpp", "void f() { auto p = nullptr; }", "auto"],
    ["cpp", "template <typename T> T id(T x) { return x; }", "template"],
    ["cpp", "namespace app { }", "namespace"],
    ["cpp", "struct A { int f() { return this->n; } int n; };", "this"],
  ];
  for (const [lang, doc, word] of keywords) {
    it(`${lang}: \`${word}\` is a keyword`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word))).toBe("keyword");
    });
  }

  const identifiers: [LangId, string, string, number?][] = [
    ["java", "class A { public static Integer wait() { return 1; } }", "Integer"],
    ["java", "class A { String name; }", "String"],
    ["javascript", "const type = kind();", "type"],
    ["python", "final = compute()\n", "final"],
    ["rust", "struct Point { x: u32 }", "Point"],
    // A TypeScript type that merely sounds primitive is still a name.
    ["typescript", "let x: Foo;", "Foo"],
    ["typescript", "let x: String;", "String"],
    // A Go name that is a keyword elsewhere, and types that aren't predeclared.
    ["go", "package main\nfunc f() { val := 1; _ = val }\n", "val"],
    ["go", "package main\nvar d Duration\n", "Duration"],
    ["go", "package main\nfunc f() error { return nil }\n", "f"],
    ["go", "package main\nfunc f() { self := 1; _ = self }\n", "self"],
    ["c", "struct foo *self;", "self"],
    ["c", "struct foo *self;", "foo"],
    ["cpp", "std::string name;", "string"],
    ["cpp", "class Parser { };", "Parser"],
    ["cpp", "namespace app { } int x = app::y;", "app", 1],
  ];
  for (const [lang, doc, word, nth] of identifiers) {
    it(`${lang}: \`${word}\` is an ordinary identifier`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word, nth))).toBe("identifier");
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
    ["go", "package main\ntype DefName struct{}\n", "DefName", 0],
    ["go", "package main\nvar x = y.FieldName\n", "FieldName", 0],
    ["cpp", "class TypeIdentifier { };", "TypeIdentifier", 0],
    ["cpp", "int Identifier = 0; int f() { return Identifier; }", "Identifier", 1],
  ];
  for (const [lang, doc, word, nth] of namedLikeNodes) {
    it(`${lang}: \`${word}\` named like its own node is an identifier`, () => {
      expect(classifyClick(stateFor(lang, doc), lang, rangeOf(doc, word, nth))).toBe("identifier");
    });
  }

  it("has no opinion where the language has no Lezer grammar", () => {
    const doc = "val limit = 5";
    expect(hasDefinitionTree("kotlin")).toBe(false);
    expect(classifyClick(stateFor("kotlin", doc), "kotlin", rangeOf(doc, "val"))).toBe("unknown");
  });
});

describe("classifySite", () => {
  const declarations: [LangId, string, string, number?][] = [
    ["java", "class A { public static Integer esperaSugerida() { return 1; } }", "esperaSugerida"],
    ["java", "class A { private final Repo repo; }", "repo"],
    ["java", "class A { @Bean public RestTemplate restTemplate() { return null; } }", "restTemplate"],
    ["javascript", "const total = 1;", "total"],
    ["javascript", "class A { render(props) { return 1; } }", "render"],
    ["typescript", "type Parser = (x: string) => Ast;", "Parser"],
    ["typescript", "const id = <T>(x: T): T => x;", "id"],
    ["tsx", "const App = () => <div />;", "App"],
    ["rust", "pub fn parse(input: &str) {}", "parse"],
    ["rust", "pub struct Point { x: u32 }", "Point"],
    ["rust", "fn f() { let mut total = 0; }", "total"],
    ["python", "def parse(self, input):\n    pass\n", "parse"],
    ["python", "total = count\n", "total"],
    ["go", "package main\nfunc Parse(input string) {}\n", "Parse"],
    ["go", "package main\nfunc Parse(input string) {}\n", "input"],
    ["go", "package main\ntype Point struct { X int }\n", "Point"],
    ["go", "package main\ntype Point struct { X int }\n", "X"],
    ["go", "package main\nfunc (p *Point) Len() int { return 0 }\n", "Len"],
    ["go", "package main\nfunc f() { resp := get(); _ = resp }\n", "resp"],
    ["go", "package main\nvar count int\n", "count"],
    ["go", "package main\nconst limit = 5\n", "limit"],
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
    ["go", "package main\nfunc f() { total = count }\n", "total"],
    ["go", "package main\nfunc f() { x := p.Len() }\n", "Len"],
    ["go", "package main\nvar d Duration\n", "Duration"],
  ];
  for (const [lang, doc, name, nth] of others) {
    it(`${lang}: vetoes ${name} in "${doc.split("\n").join(" ⏎ ")}"`, () => {
      expect(classifySite(stateFor(lang, doc), lang, rangeOf(doc, name, nth))).toBe("other");
    });
  }

  it("has no opinion where the language has no Lezer grammar", () => {
    const doc = "var count = 1";
    expect(classifySite(stateFor("kotlin", doc), "kotlin", rangeOf(doc, "count"))).toBe("unknown");
  });

  // C/C++ declarators nest too many ways to veto a candidate: keyword answers only.
  it("has no opinion on C and C++ declarations", () => {
    const doc = "int Foo::bar(int x) { return x; }";
    expect(hasDefinitionTree("cpp")).toBe(true);
    expect(classifySite(stateFor("cpp", doc), "cpp", rangeOf(doc, "bar"))).toBe("unknown");
    expect(classifySite(stateFor("c", "int total;"), "c", rangeOf("int total;", "total"))).toBe("unknown");
  });
});

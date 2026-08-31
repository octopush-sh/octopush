import { describe, it, expect } from "vitest";
import {
  DEFINITION_SCORE,
  isNavigableSymbol,
  findDefinitions,
  identifierAt,
  identifierNear,
  isIdentifier,
  isSignaturePrefix,
  scoreDefinitionAt,
  scoreDefinitionLine,
  isParameterList,
  wordOccurrences,
  NON_SYMBOL_WORDS,
} from "./symbolIndex";

describe("identifierAt", () => {
  const doc = "const total = count + 1;";

  it("resolves the word under the caret", () => {
    expect(identifierAt(doc, doc.indexOf("count") + 2)?.name).toBe("count");
  });

  it("resolves the word the caret sits just after", () => {
    // Arrowing to the end of a word must still resolve that word — every
    // editor does this, and ⌘-click on the last character depends on it.
    const end = doc.indexOf("count") + "count".length;
    expect(identifierAt(doc, end)?.name).toBe("count");
  });

  it("returns the offsets of the whole identifier", () => {
    const hit = identifierAt(doc, doc.indexOf("total"));
    expect(hit).toEqual({ name: "total", from: 6, to: 11 });
  });

  it("declines punctuation, whitespace and number literals", () => {
    expect(identifierAt(doc, doc.indexOf("+"))).toBeNull();
    expect(identifierAt("a  b", 2)).toBeNull();
    expect(identifierAt("x = 42;", 5)).toBeNull();
  });

  it("declines an out-of-range position", () => {
    expect(identifierAt(doc, -1)).toBeNull();
    expect(identifierAt(doc, doc.length + 5)).toBeNull();
  });
});

describe("identifierNear", () => {
  const read = (doc: string) => (from: number, to: number) => doc.slice(from, to);

  it("matches identifierAt without materialising the document", () => {
    const doc = "x".repeat(5000) + " widget.height";
    const pos = doc.indexOf("height") + 1;
    expect(identifierNear(read(doc), doc.length, pos)?.name).toBe("height");
    expect(identifierNear(read(doc), doc.length, pos)?.from).toBe(doc.indexOf("height"));
  });

  it("widens to the whole document when the word runs off the window", () => {
    // A 400-char identifier straddles the 256-char read window; the windowed
    // pass would report a truncated name, so it has to re-read.
    const name = "a".repeat(400);
    const doc = `const ${name} = 1;`;
    const hit = identifierNear(read(doc), doc.length, doc.indexOf(name) + 200);
    expect(hit?.name).toBe(name);
  });
});

describe("wordOccurrences", () => {
  it("matches whole words only", () => {
    const text = "id, width, id2, grid, id";
    expect(wordOccurrences(text, "id")).toEqual([
      { from: 0, to: 2 },
      { from: 22, to: 24 },
    ]);
  });

  it("shifts by the given offset", () => {
    expect(wordOccurrences("a b", "b", 100)).toEqual([{ from: 102, to: 103 }]);
  });

  it("returns nothing for an empty name", () => {
    expect(wordOccurrences("anything", "")).toEqual([]);
  });
});

describe("isIdentifier", () => {
  it("accepts identifiers and rejects everything else", () => {
    expect(isIdentifier("_foo$1")).toBe(true);
    expect(isIdentifier("1foo")).toBe(false);
    expect(isIdentifier("foo bar")).toBe(false);
    expect(isIdentifier("")).toBe(false);
  });
});

describe("scoreDefinitionAt — declarations", () => {
  const cases: [string, string][] = [
    ["function parse(input) {", "parse"],
    ["export const parse = (x) => x;", "parse"],
    ["  let parse = 1", "parse"],
    ["pub fn parse(input: &str) -> Ast {", "parse"],
    ["def parse(self, input):", "parse"],
    ["class Parser {", "Parser"],
    ["export interface Parser {", "Parser"],
    ["type Parser = (x: string) => Ast;", "Parser"],
    ["struct Parser {", "Parser"],
    ["func parse(input string) error {", "parse"],
    ["var parse = 1", "parse"],
  ];
  for (const [line, name] of cases) {
    it(`scores "${line.trim()}" as a declaration`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBe(
        DEFINITION_SCORE.declaration,
      );
    });
  }
});

describe("scoreDefinitionAt — signatures", () => {
  it("scores a Java-style method declaration", () => {
    const line = "  public static void main(String[] args) {";
    expect(scoreDefinitionAt(line, line.indexOf("main"), "main")).toBe(
      DEFINITION_SCORE.signature,
    );
  });

  it("scores a bare method in a class body", () => {
    const line = "  render(props) {";
    expect(scoreDefinitionAt(line, line.indexOf("render"), "render")).toBe(
      DEFINITION_SCORE.signature,
    );
  });

  it("scores a Go method with a receiver", () => {
    const line = "func (r *Repo) Save(x int) error {";
    expect(scoreDefinitionAt(line, line.indexOf("Save"), "Save")).toBe(
      DEFINITION_SCORE.signature,
    );
  });
});

describe("scoreDefinitionAt — assignments", () => {
  it("scores a bare binding", () => {
    const line = "    total = compute()";
    expect(scoreDefinitionAt(line, line.indexOf("total"), "total")).toBe(
      DEFINITION_SCORE.assignment,
    );
  });

  it("scores a Go short declaration", () => {
    const line = "  count := len(items)";
    expect(scoreDefinitionAt(line, line.indexOf("count"), "count")).toBe(
      DEFINITION_SCORE.assignment,
    );
  });

  it("does not score a comparison or an arrow parameter", () => {
    const eq = "if total == 3 {";
    expect(scoreDefinitionAt(eq, eq.indexOf("total"), "total")).toBe(0);
    const arrow = "items.map(item => item.id)";
    expect(scoreDefinitionAt(arrow, arrow.indexOf("item"), "item")).toBe(0);
  });
});

describe("scoreDefinitionAt — refusals", () => {
  // Each of these is a call or a control statement that a naive "name followed
  // by ( on a line ending in {" rule would happily mistake for a definition.
  const refusals: [string, string][] = [
    ["if (ready) {", "ready"],
    ["while (next()) {", "next"],
    ["  if err := load(); err != nil {", "load"],
    ['describe("parser", () => {', "describe"],
    ["  return parse(input);", "parse"],
    ["  this.parse(input);", "parse"],
    ["  self::parse(input);", "parse"],
    ["  parse(input);", "parse"],
    ["import { parse } from './parser';", "parse"],
    ["  for (const item of items) {", "items"],
  ];
  for (const [line, name] of refusals) {
    it(`refuses "${line.trim()}"`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBe(0);
    });
  }

  it("refuses a partial word match", () => {
    const line = "const parseAll = 1";
    expect(scoreDefinitionAt(line, line.indexOf("parseAll"), "parse")).toBe(0);
  });
});

describe("isSignaturePrefix", () => {
  it("accepts modifiers, a return type and a Go receiver", () => {
    expect(isSignaturePrefix("")).toBe(true);
    expect(isSignaturePrefix("  public static void ")).toBe(true);
    expect(isSignaturePrefix("func (r *Repo) ")).toBe(true);
    expect(isSignaturePrefix("Map<String, Int> ")).toBe(true);
  });

  it("rejects expressions and member access", () => {
    expect(isSignaturePrefix("if err := ")).toBe(false);
    expect(isSignaturePrefix("return ")).toBe(false);
    expect(isSignaturePrefix("this.")).toBe(false);
    expect(isSignaturePrefix("foo(bar, ")).toBe(false);
    expect(isSignaturePrefix("a b c d e ")).toBe(false);
  });
});

describe("scoreDefinitionLine", () => {
  it("takes the best score any occurrence on the line earns", () => {
    expect(scoreDefinitionLine("const parse = () => parse;", "parse")).toBe(
      DEFINITION_SCORE.declaration,
    );
    expect(scoreDefinitionLine("  parse(input);", "parse")).toBe(0);
  });
});

describe("findDefinitions", () => {
  const doc = [
    "import { helper } from './helper';",  // 1
    "",                                    // 2
    "function run(input) {",               // 3
    "  const value = helper(input);",      // 4
    "  return value;",                     // 5
    "}",                                   // 6
    "",                                    // 7
    "run = 5;",                            // 8
  ].join("\n");

  it("finds the declaration and reports its line", () => {
    const [best] = findDefinitions(doc, "value");
    expect(best.line).toBe(4);
    expect(best.score).toBe(DEFINITION_SCORE.declaration);
    expect(doc.slice(best.from, best.to)).toBe("value");
  });

  it("ranks a declaration above a later re-assignment", () => {
    const sites = findDefinitions(doc, "run");
    expect(sites.map((s) => s.line)).toEqual([3, 8]);
    expect(sites[0].score).toBeGreaterThan(sites[1].score);
  });

  it("does not treat an import binding as a definition", () => {
    expect(findDefinitions(doc, "helper")).toEqual([]);
  });

  it("returns nothing for a non-identifier", () => {
    expect(findDefinitions(doc, "not an identifier")).toEqual([]);
  });
});

describe("keywords are never definitions of themselves", () => {
  // The `signature` tier reads "name, parameter list, line opens a body" — which
  // `if (ready) {` matches exactly. Scoring it 70 meant ⌘-click on `if` jumped
  // to another `if`, or escalated to a workspace-wide search for the word.
  const keywordLines: [string, string][] = [
    ["if (ready) {", "if"],
    ["for (const x of xs) {", "for"],
    ["while (next()) {", "while"],
    ["switch (kind) {", "switch"],
    ["catch (e) {", "catch"],
  ];
  for (const [line, name] of keywordLines) {
    it(`scores \`${name}\` on "${line}" as nothing`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBe(0);
      expect(scoreDefinitionLine(line, name)).toBe(0);
    });
  }
});

describe("a call that ends in a brace is not a declaration", () => {
  // The `signature` tier used to test only for "a `(` after the name and a `{`
  // at the end of the line", which every one of these matches — so ⌘-click
  // answered "already at the definition" for a plain call and never searched.
  const calls: [string, string][] = [
    ["export default defineConfig({", "defineConfig"],
    ['describe("suite", {', "describe"],
    ["register(name, {", "register"],
    ["  app.use(cors({", "use"],
  ];
  for (const [line, name] of calls) {
    it(`refuses "${line.trim()}"`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBe(0);
    });
  }

  const declarations: [string, string][] = [
    ["  render(props) {", "render"],
    ["  public static void main(String[] args) {", "main"],
    ["func (r *Repo) Save(x int) error {", "Save"],
    ["  def parse(self, input):", "parse"],
    ["fn build(&self) -> Result<Widget, Error> {", "build"],
  ];
  for (const [line, name] of declarations) {
    it(`still accepts "${line.trim()}"`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBeGreaterThan(0);
    });
  }
});

describe("isParameterList", () => {
  it("requires the parentheses to close before the body opens", () => {
    expect(isParameterList("(props) {")).toBe(true);
    expect(isParameterList("(a, b) -> Result<T, E> {")).toBe(true);
    expect(isParameterList("(self, input):")).toBe(true);
    expect(isParameterList("<T>(value: T) {")).toBe(true);
    expect(isParameterList("({")).toBe(false);
    expect(isParameterList('("suite", {')).toBe(false);
    expect(isParameterList("(x);")).toBe(false);
    expect(isParameterList(" = 5")).toBe(false);
  });
});

describe("statement heads are refused, but only as signature names", () => {
  it("refuses a condition that is shaped like a signature", () => {
    for (const [line, name] of [
      ["if (ready) {", "if"],
      ["for (const x of xs) {", "for"],
      ["while (next()) {", "while"],
      ["switch (kind) {", "switch"],
      ["catch (e) {", "catch"],
    ] as [string, string][]) {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBe(0);
    }
  });

  it("still resolves a declaring keyword in front of one", () => {
    // The regression a wider list caused: `new` and `delete` are ordinary
    // method names, and `fn new` is the single most common one in Rust.
    const rust = "    pub fn new(path: PathBuf) -> Self {";
    expect(scoreDefinitionAt(rust, rust.indexOf("new"), "new")).toBe(
      DEFINITION_SCORE.declaration,
    );
    const js = "  delete(id) {";
    expect(scoreDefinitionAt(js, js.indexOf("delete"), "delete")).toBe(
      DEFINITION_SCORE.signature,
    );
  });
});

describe("ordinary identifiers that happen to be pooled keywords", () => {
  // The guard above must be the NARROW control set. Using the broad
  // `NON_SYMBOL_WORDS` pool here silently killed the in-file jump for names
  // like these, which are entirely ordinary in real code.
  const ordinary: [string, string][] = [
    ["export function use(hook) {", "use"],
    ["  get(key) {", "get"],
    ["const type = kind();", "type"],
    ["let record = {};", "record"],
    ["def match(self, x):", "match"],
  ];
  for (const [line, name] of ordinary) {
    it(`still scores \`${name}\` on "${line.trim()}"`, () => {
      expect(scoreDefinitionAt(line, line.indexOf(name), name)).toBeGreaterThan(0);
      expect(findDefinitions(line, name)).toHaveLength(1);
    });
  }
});

describe("isNavigableSymbol", () => {
  it("is the one gate both the highlighter and ⌘-click go through", () => {
    expect(isNavigableSymbol("parse")).toBe(true);
    expect(isNavigableSymbol("if")).toBe(false);
    expect(isNavigableSymbol("return")).toBe(false);
    expect(isNavigableSymbol("1foo")).toBe(false);
    expect(isNavigableSymbol("")).toBe(false);
  });
});

describe("NON_SYMBOL_WORDS", () => {
  it("covers the keywords that would otherwise wash the screen", () => {
    for (const w of ["return", "const", "if", "self", "true", "None", "fn"]) {
      expect(NON_SYMBOL_WORDS.has(w)).toBe(true);
    }
    expect(NON_SYMBOL_WORDS.has("parse")).toBe(false);
  });
});

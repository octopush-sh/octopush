import { describe, it, expect, vi, beforeEach } from "vitest";

const searchWorkspaceText = vi.fn();
const readFileLines = vi.fn();
vi.mock("./ipc", () => ({ ipc: { searchWorkspaceText, readFileLines } }));

const { SYMBOL_MAX_LINES, definitionLength, findSymbolRows, isSymbolQuery } = await import("./talkSymbols");
const { dirsOf, extractContextRefs } = await import("./talkContext");

describe("isSymbolQuery", () => {
  it("looks up identifiers of three characters or more, never paths or tokens", () => {
    expect(isSymbolQuery("parseToken")).toBe(true);
    expect(isSymbolQuery("$el")).toBe(true);
    expect(isSymbolQuery("ab")).toBe(false);
    expect(isSymbolQuery("src/a")).toBe(false);
    expect(isSymbolQuery("chat:x")).toBe(false);
    expect(isSymbolQuery("a.ts")).toBe(false);
    expect(isSymbolQuery("9lives")).toBe(false);
  });
});

describe("definitionLength", () => {
  it("ends where the definition's braces close", () => {
    const src = [
      "fn parse(input: &str) -> Result<Token> {",
      '    let open = "{";',
      "    if x { y }",
      "}",
      "fn next() {}",
    ];
    expect(definitionLength(src)).toBe(4);
    expect(definitionLength(["fn a() {}", "fn b() {}"])).toBe(1);
  });

  it("follows a signature over several lines and a brace on the next line", () => {
    expect(definitionLength(["export function run(", "  a: number,", "): void {", "  go();", "}", "x"])).toBe(5);
    expect(definitionLength(["public void Run()", "{", "  Go();", "}", "int x;"])).toBe(4);
  });

  it("ends an indented body where the indentation returns", () => {
    const py = ["def parse(text):", "    out = []", "", "    return out", "", "def other():", "    pass"];
    expect(definitionLength(py)).toBe(4);
    expect(definitionLength(["    def m(self):", "        return 1", "    def n(self):"])).toBe(2);
  });

  it("is the line itself for a one-line statement", () => {
    expect(definitionLength(["type Id = string;", "type B = number;"])).toBe(1);
    expect(definitionLength(["MAX_RETRIES = 5", "other = 1"])).toBe(1);
    expect(definitionLength(["const LIMIT: usize = 10;"])).toBe(1);
  });

  it("spans every line read when the definition doesn't close in them", () => {
    expect(definitionLength(["struct Big {", "  a: u8,", "  b: u8,"])).toBe(3);
  });
});

describe("findSymbolRows", () => {
  const files = ["src/token.rs", "src/lexer.rs", "tests/token_test.rs"];
  const catalog = new Set(files);

  beforeEach(() => {
    searchWorkspaceText.mockReset();
    readFileLines.mockReset();
  });

  it("ranks definitions over uses and inserts a range that resolves as a token", async () => {
    searchWorkspaceText.mockResolvedValue([
      { file: "src/lexer.rs", line: 40, col: 9, preview: "    let t = parse_token(s);" },
      { file: "tests/token_test.rs", line: 3, col: 4, preview: "fn parse_token() {" },
      { file: "src/token.rs", line: 12, col: 8, preview: "pub fn parse_token(s: &str) -> Token {" },
      { file: "target/gen.rs", line: 1, col: 4, preview: "fn parse_token() {" },
    ]);
    readFileLines.mockImplementation(async (_path: string, start: number) => ({
      kind: "text",
      content: ["fn parse_token() {", "  body", "}", "next"].join("\n"),
      start,
      end: start + 3,
      total: null,
      cut: false,
    }));
    const rows = await findSymbolRows("/w", "parse_token", catalog);
    expect(searchWorkspaceText).toHaveBeenCalledWith("/w", "parse_token", true, true);
    // The use is no definition; the file `@` can't name is not offered; the
    // source file outranks the test.
    expect(rows.map((r) => r.token)).toEqual(["src/token.rs#L12-14", "tests/token_test.rs#L3-5"]);
    expect(rows[0]).toMatchObject({ name: "parse_token", file: "src/token.rs", start: 12, end: 14 });
    expect(readFileLines).toHaveBeenCalledWith("/w/src/token.rs", 12, 12 + SYMBOL_MAX_LINES - 1, 64_000);
    // The inserted token is a valid line range of a file in the catalog.
    const cat = { files: catalog, dirs: dirsOf(files), sessions: [] };
    expect(extractContextRefs(`@${rows[0].token}`, cat)).toMatchObject([
      { kind: "file", path: "src/token.rs", range: { start: 12, end: 14 } },
    ]);
  });

  it("falls back to the definition's own line when the file can't be read", async () => {
    searchWorkspaceText.mockResolvedValue([{ file: "src/token.rs", line: 7, col: 1, preview: "struct Token {" }]);
    readFileLines.mockRejectedValue(new Error("gone"));
    expect((await findSymbolRows("/w", "Token", catalog)).map((r) => r.token)).toEqual(["src/token.rs#L7"]);
    readFileLines.mockResolvedValue({ kind: "binary" });
    expect((await findSymbolRows("/w", "Token", catalog)).map((r) => r.token)).toEqual(["src/token.rs#L7"]);
  });

  it("searches nothing for a query that isn't an identifier", async () => {
    expect(await findSymbolRows("/w", "src/", catalog)).toEqual([]);
    expect(searchWorkspaceText).not.toHaveBeenCalled();
  });
});

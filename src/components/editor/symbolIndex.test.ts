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
  isReservedWord,
  scoreOptionsFor,
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
  it("scores a Java-style method as a typed declaration", () => {
    // Modifiers and a return type in front: the name is what's declared.
    const line = "  public static void main(String[] args) {";
    expect(scoreDefinitionAt(line, line.indexOf("main"), "main")).toBe(
      DEFINITION_SCORE.declaration,
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

/** Score the first whole-word occurrence of `name` on `line`. */
const scoreOf = (line: string, name: string, opts = {}) =>
  scoreDefinitionAt(line, wordOccurrences(line, name)[0].from, name, opts);

describe("the type in front of a declaration is never its name", () => {
  // Each line declares `declared`; `type` is the word in front of it that used
  // to score 100 because a modifier (`static`, `const`, `impl`, …) preceded it.
  const cases: { lang: string; line: string; type: string; declared: string }[] = [
    { lang: "Java", line: "  public static Integer esperaSugerida() {", type: "Integer", declared: "esperaSugerida" },
    { lang: "Java", line: "  static String format(String pattern, Object... args) {", type: "String", declared: "format" },
    { lang: "Java", line: "  private final UserRepository userRepository;", type: "UserRepository", declared: "userRepository" },
    { lang: "Java", line: "  public static final int MAX_RETRIES = 3;", type: "int", declared: "MAX_RETRIES" },
    { lang: "Java", line: "    List<String> names = new ArrayList<>();", type: "List", declared: "names" },
    { lang: "Java", line: "  Map<String, List<Integer>> byOwner;", type: "Map", declared: "byOwner" },
    { lang: "Java", line: "  public abstract Optional<User> findById(long id);", type: "Optional", declared: "findById" },
    { lang: "Java", line: "  public ResponseEntity<User> create(", type: "ResponseEntity", declared: "create" },
    { lang: "C#", line: "    public string Name { get; set; }", type: "string", declared: "Name" },
    { lang: "C#", line: "    public int Count => _items.Count;", type: "int", declared: "Count" },
    { lang: "C#", line: "    public event EventHandler Changed;", type: "EventHandler", declared: "Changed" },
    { lang: "C#", line: "    private readonly ILogger<Worker> _logger;", type: "ILogger", declared: "_logger" },
    { lang: "C#", line: "    public async Task<User> LoadAsync(int id)", type: "Task", declared: "LoadAsync" },
    { lang: "C", line: "const char *name = \"octo\";", type: "char", declared: "name" },
    { lang: "C", line: "static void helper(void);", type: "void", declared: "helper" },
    { lang: "C", line: "int main(int argc, char **argv) {", type: "int", declared: "main" },
    { lang: "C", line: "    struct Node *next;", type: "Node", declared: "next" },
    { lang: "C", line: "    char buf[64];", type: "char", declared: "buf" },
    { lang: "C++", line: "    std::string label = \"x\";", type: "string", declared: "label" },
    { lang: "TS", line: "  private readonly repo: Repo;", type: "Repo", declared: "repo" },
  ];
  for (const { lang, line, type, declared } of cases) {
    it(`${lang}: "${line.trim()}" declares ${declared}, not ${type}`, () => {
      const opts = scoreOptionsFor(lang === "C" ? "c" : lang === "C++" ? "cpp" : undefined);
      expect(scoreDefinitionLine(line, declared, opts)).toBe(DEFINITION_SCORE.declaration);
      expect(scoreDefinitionLine(line, type, opts)).toBe(0);
    });
  }

  it("the owner's case: Integer never resolves to a method returning Integer", () => {
    const doc = [
      "public class ProveedorNoDisponibleException extends RuntimeException {",
      "  public static Integer esperaSugerida() {",
      "    return 30;",
      "  }",
      "  public static Integer otraEspera(Integer base) { return base; }",
      "  private final Integer reintentos;",
      "}",
    ].join("\n");
    expect(findDefinitions(doc, "Integer")).toEqual([]);
    expect(findDefinitions(doc, "esperaSugerida").map((s) => s.line)).toEqual([2]);
  });
});

describe("modifiers and keywords that name something else declare nothing", () => {
  const refusals: { lang: string; line: string; name: string }[] = [
    { lang: "Rust", line: "impl Display for Foo {", name: "Display" },
    { lang: "Rust", line: "impl Display for Foo {", name: "Foo" },
    { lang: "Rust", line: "impl Foo {", name: "Foo" },
    { lang: "Java", line: "package com.acme.billing;", name: "com" },
    { lang: "Kotlin", line: "package com.acme", name: "com" },
    { lang: "C#", line: "    public static Integer Wait() => 3;", name: "Integer" },
    { lang: "C", line: "const char *name;", name: "const" },
    { lang: "Java", line: "    return value;", name: "value" },
    { lang: "Java", line: "    throw error;", name: "error" },
    { lang: "Go", line: "\tdefer cleanup()", name: "cleanup" },
    { lang: "Go", line: "\tgo worker(jobs)", name: "worker" },
    { lang: "Ruby", line: "  puts format(total)", name: "format" },
    { lang: "Python", line: "print total", name: "total" },
    { lang: "TS", line: "export default build();", name: "build" },
    { lang: "TS", line: "export default defineConfig({", name: "defineConfig" },
    // A re-export names a declaration elsewhere; in the workspace tier (no
    // tree) it used to tie with `function App()` and open a picker.
    { lang: "TS", line: "export default App;", name: "App" },
    { lang: "TS", line: "export default App", name: "App" },
    { lang: "TS", line: "export App;", name: "App" },
    { lang: "Java", line: "    else retry = false;", name: "retry" },
  ];
  for (const { lang, line, name } of refusals) {
    it(`${lang}: refuses ${name} on "${line.trim()}"`, () => {
      expect(scoreDefinitionLine(line, name)).toBe(0);
    });
  }
});

describe("declarations the old keyword rule missed", () => {
  const cases: { lang: string; line: string; name: string; opts?: { typeAfterName?: boolean } }[] = [
    { lang: "Java", line: "  @Bean public RestTemplate restTemplate(RestTemplateBuilder builder) {", name: "restTemplate" },
    { lang: "Java", line: '  @GetMapping("/users/{id}") public User show(@PathVariable long id) {', name: "show" },
    { lang: "Java", line: "  @Autowired private UserService users;", name: "users" },
    { lang: "Java", line: "    for (String line : lines) {", name: "line" },
    { lang: "Java", line: "    } catch (IOException e) {", name: "e" },
    { lang: "Java", line: "    var retries = 3;", name: "retries" },
    { lang: "Kotlin", line: "fun double(x: Int) = x * 2", name: "double" },
    { lang: "Kotlin", line: "    override fun toString() = name", name: "toString" },
    { lang: "Kotlin", line: "fun <T> listOfOne(item: T): List<T> = listOf(item)", name: "listOfOne" },
    { lang: "Kotlin", line: "    private val repo: Repo = Repo()", name: "repo" },
    { lang: "C#", line: "    [HttpGet] public IActionResult Index()", name: "Index" },
    { lang: "C#", line: "    public required string Email { get; init; }", name: "Email" },
    { lang: "TS", line: "  private retries?: number;", name: "retries" },
    { lang: "TS", line: "  static parse(input: string): Ast {", name: "parse" },
    { lang: "TS", line: "  const total: number = 0;", name: "total" },
    { lang: "Rust", line: "    let mut total: u32 = 0;", name: "total" },
    { lang: "Rust", line: "pub const MAX: usize = 8;", name: "MAX" },
    { lang: "Rust", line: "static mut COUNTER: u32 = 0;", name: "COUNTER" },
    { lang: "Rust", line: "pub struct Point<T> where T: Copy {", name: "Point" },
    { lang: "C", line: "    int count = 0;", name: "count" },
    { lang: "C", line: "unsigned long hash(const char *s) {", name: "hash" },
    { lang: "Go", line: "var count int", name: "count", opts: { typeAfterName: true } },
    { lang: "Go", line: "const limit Duration = 5", name: "limit", opts: { typeAfterName: true } },
    { lang: "Go", line: "type Server struct {", name: "Server", opts: { typeAfterName: true } },
  ];
  for (const { lang, line, name, opts } of cases) {
    it(`${lang}: "${line.trim()}" declares ${name}`, () => {
      expect(scoreOf(line, name, opts)).toBe(DEFINITION_SCORE.declaration);
    });
  }

  it("Go: the type after a typed const is not its name", () => {
    const opts = scoreOptionsFor("go");
    expect(scoreDefinitionLine("const limit Duration = 5", "Duration", opts)).toBe(0);
    expect(scoreDefinitionLine("var count int", "int", opts)).toBe(0);
  });

  it("only Go writes the type after the name", () => {
    expect(scoreOptionsFor("go").typeAfterName).toBe(true);
    for (const lang of ["java", "rs", "ts", "kt", "cs", "c", undefined]) {
      expect(scoreOptionsFor(lang).typeAfterName).toBe(false);
    }
  });
});

describe("declarations split after their type", () => {
  // `public static Integer` alone on a line used to score 100 for `Integer`
  // (a binding modifier in front, nothing after it), and the workspace tier
  // then jumped there for every ⌘-click on `Integer`.
  const heads: { lang: string; line: string; type: string; ext?: string }[] = [
    { lang: "Java", line: "    public static Integer", type: "Integer" },
    { lang: "Java", line: "    private final UserRepository", type: "UserRepository" },
    { lang: "Java", line: "    public static Integer // retries", type: "Integer" },
    { lang: "C", line: "static int", type: "int", ext: "c" },
    { lang: "C", line: "static Node", type: "Node", ext: "c" },
  ];
  for (const { lang, line, type, ext } of heads) {
    it(`${lang}: a type alone after modifiers, "${line.trim()}", declares nothing`, () => {
      expect(scoreDefinitionLine(line, type, scoreOptionsFor(ext))).toBe(0);
    });
  }

  it("Go still declares a bare name after var/const", () => {
    const go = scoreOptionsFor("go");
    expect(scoreDefinitionLine("var count", "count", go)).toBe(DEFINITION_SCORE.declaration);
    expect(scoreDefinitionLine("const limit", "limit", go)).toBe(DEFINITION_SCORE.declaration);
  });

  const docs: { lang: string; ext?: string; doc: string[]; type: string; declared: string; line: number }[] = [
    {
      lang: "Java",
      doc: ["class A {", "    public static Integer", "    esperaSugerida(int a, int b) {", "        return a;", "    }", "}"],
      type: "Integer",
      declared: "esperaSugerida",
      line: 3,
    },
    {
      lang: "Java",
      doc: ["class A {", "    private final UserRepository", "        userRepository;", "}"],
      type: "UserRepository",
      declared: "userRepository",
      line: 3,
    },
    {
      lang: "C",
      ext: "c",
      doc: ["static int", "helper(void)", "{", "    return 0;", "}"],
      type: "int",
      declared: "helper",
      line: 2,
    },
    {
      lang: "C",
      ext: "c",
      doc: ["int", "main(int argc, char **argv)", "{", "}"],
      type: "int",
      declared: "main",
      line: 2,
    },
  ];
  for (const { lang, ext, doc, type, declared, line } of docs) {
    it(`${lang}: finds ${declared} on the line after "${doc[line - 2].trim()}", never ${type}`, () => {
      const text = doc.join("\n");
      const opts = scoreOptionsFor(ext);
      expect(findDefinitions(text, type, opts)).toEqual([]);
      const [site] = findDefinitions(text, declared, opts);
      expect(site.line).toBe(line);
      expect(site.score).toBe(DEFINITION_SCORE.declaration);
      expect(text.slice(site.from, site.to)).toBe(declared);
    });
  }

  it("does not join a line that is an expression or a bare name", () => {
    // Python: `Foo` alone is an expression statement, not a type.
    const py = ["Foo", "bar = 1"].join("\n");
    expect(findDefinitions(py, "bar")[0].score).toBe(DEFINITION_SCORE.assignment);
    const js = ["return", "value;"].join("\n");
    expect(findDefinitions(js, "value")).toEqual([]);
  });
});

describe("C typedefs", () => {
  const c = scoreOptionsFor("c");
  const cases: [string, string][] = [
    ["typedef struct Node Node;", "Node"],
    ["typedef struct node_s node_t;", "node_t"],
    ["typedef unsigned long size_type;", "size_type"],
    ["typedef int Count;", "Count"],
  ];
  for (const [line, name] of cases) {
    it(`"${line}" declares ${name}`, () => {
      expect(scoreDefinitionLine(line, name, c)).toBe(DEFINITION_SCORE.declaration);
      expect(scoreDefinitionLine(line, name)).toBe(DEFINITION_SCORE.declaration);
    });
  }

  it("does not declare the type being aliased", () => {
    expect(scoreDefinitionLine("typedef struct node_s node_t;", "node_s", c)).toBe(0);
  });
});

describe("pointer declarators are C and C++ only", () => {
  const c = scoreOptionsFor("c");
  it("reads `*` as multiplication elsewhere", () => {
    for (const ext of [undefined, "java", "ts", "py", "rs", "kt", "cs"]) {
      const opts = scoreOptionsFor(ext);
      expect(scoreDefinitionLine("    total * rate;", "rate", opts)).toBe(0);
      expect(scoreDefinitionLine("    ptr * deref;", "deref", opts)).toBe(0);
      expect(scoreDefinitionLine("    a & mask;", "mask", opts)).toBe(0);
    }
  });

  it("still reads a C declarator", () => {
    expect(scoreDefinitionLine("    struct Node *next;", "next", c)).toBe(DEFINITION_SCORE.declaration);
    expect(scoreDefinitionLine("const char *name = \"octo\";", "name", c)).toBe(
      DEFINITION_SCORE.declaration,
    );
    expect(scoreDefinitionLine("    int &ref = x;", "ref", scoreOptionsFor("cpp"))).toBe(
      DEFINITION_SCORE.declaration,
    );
  });

  it("knows C and C++ by language and by extension", () => {
    for (const k of ["c", "cpp", "h", "cc", "cxx", "hpp"]) expect(scoreOptionsFor(k).cDeclarators).toBe(true);
    for (const k of ["java", "go", "ts", "javascript", undefined]) {
      expect(scoreOptionsFor(k).cDeclarators).toBe(false);
    }
  });
});

describe("long lines", () => {
  it("scores a minified line of thousands of words without stalling", () => {
    const line = "a ".repeat(20_000) + "const total = 1;";
    const started = performance.now();
    expect(scoreDefinitionLine(line, "total")).toBe(DEFINITION_SCORE.declaration);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("isReservedWord", () => {
  it("holds a language's modifiers and type keywords", () => {
    for (const w of ["const", "static", "int", "void", "if", "public"]) {
      expect(isReservedWord("java", w)).toBe(true);
    }
    for (const w of ["impl", "fn", "self", "mut", "u32"]) expect(isReservedWord("rust", w)).toBe(true);
    for (const w of ["val", "fun"]) expect(isReservedWord("kotlin", w)).toBe(true);
    for (const w of ["def", "lambda", "None"]) expect(isReservedWord("python", w)).toBe(true);
  });

  it("never holds ordinary names", () => {
    for (const w of ["get", "type", "use", "record", "new", "default", "String", "Integer"]) {
      expect(isReservedWord("javascript", w)).toBe(false);
    }
  });

  it("only reserves a word in the languages that reserve it", () => {
    // Ordinary names in Go and C, keywords elsewhere.
    for (const w of ["val", "self", "fn", "def", "let", "mut", "pub", "impl", "trait", "this", "class"]) {
      expect(isReservedWord("go", w)).toBe(false);
      expect(isReservedWord("c", w)).toBe(false);
    }
    expect(isReservedWord("python", "self")).toBe(false);
    expect(isReservedWord("go", "func")).toBe(true);
    expect(isReservedWord("c", "struct")).toBe(true);
  });

  it("falls back to statement heads for a language without a list", () => {
    expect(isReservedWord("shell", "if")).toBe(true);
    expect(isReservedWord(undefined, "while")).toBe(true);
    expect(isReservedWord("shell", "static")).toBe(false);
  });
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

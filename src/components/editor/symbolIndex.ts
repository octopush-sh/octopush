/**
 * Symbol analysis for the editor — occurrence lookup and a definition
 * heuristic, both pure so they can be unit-tested without a live CodeMirror.
 *
 * Octopush has no language server. A real one would answer "where is this
 * declared?" from a resolved scope graph; we answer it from the shape of the
 * line the identifier sits on. That is a heuristic, and it is deliberately a
 * CONSERVATIVE one: every rule below refuses far more lines than it accepts,
 * because a wrong jump costs the reader more than no jump at all (they lose
 * their place, then still have to search by hand). When nothing scores, the
 * caller falls back to workspace search and says so.
 *
 * Three shapes are recognised, in descending confidence:
 *
 *   declaration (100)  a declaring keyword immediately precedes the name —
 *                      `function foo`, `const foo`, `fn foo`, `def foo`,
 *                      `class Foo`, `type Foo`, `struct Foo`, … — or the
 *                      name is the declarator of a typed declaration:
 *                      modifiers and annotations, at most one type, then the
 *                      name (`private final Repo repo;`, `int count = 0`).
 *                      The TYPE in front is never the declared name:
 *                      `static Integer f()` declares `f`, not `Integer`.
 *   signature   (70)   the name is followed by a parameter list and the line
 *                      opens a body — `public void foo(…) {`, `foo(…) {`,
 *                      `func (r *R) foo(…) {` — with a prefix that can only
 *                      be modifiers and a return type.
 *   assignment  (40)   the name is the left side of an assignment with
 *                      nothing but modifiers in front — `foo = …`,
 *                      `foo := …`. Python and Go bind names this way.
 *
 * Scores are comparable across files, so `definitionSearch.ts` reuses
 * `scoreDefinitionAt` to rank workspace-wide hits with the same yardstick.
 */

/** One identifier occurrence in a document, as absolute offsets. */
export interface SymbolRange {
  from: number;
  to: number;
}

/** A candidate definition site inside one document. */
export interface DefinitionSite extends SymbolRange {
  /** 1-based line number. */
  line: number;
  /** Confidence, from the ladder above. Higher wins. */
  score: number;
}

export const DEFINITION_SCORE = {
  declaration: 100,
  signature: 70,
  assignment: 40,
} as const;

/** Characters that may appear inside an identifier. Deliberately ASCII: every
 *  language Octopush highlights uses this set, and widening it to \p{L} would
 *  start matching prose in Markdown and comments. */
const IDENT_RE = /[A-Za-z0-9_$]/;

const isIdentChar = (ch: string | undefined) => !!ch && IDENT_RE.test(ch);

/** True when `name` is shaped like an identifier (so it cannot start a
 *  number, and cannot carry punctuation a word-boundary scan would mis-seat). */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * The identifier surrounding (or immediately before) `pos`, or null.
 *
 * Looks under the caret first, then one character back — clicking or arrowing
 * to the far edge of a word should still resolve that word, which is what
 * every editor does and what `⌘`-click needs to feel exact.
 */
export function identifierAt(
  doc: string,
  pos: number,
): { name: string; from: number; to: number } | null {
  if (pos < 0 || pos > doc.length) return null;
  let start = pos;
  if (!isIdentChar(doc[start]) && isIdentChar(doc[start - 1])) start = pos - 1;
  if (!isIdentChar(doc[start])) return null;

  let from = start;
  while (from > 0 && isIdentChar(doc[from - 1])) from--;
  let to = start + 1;
  while (to < doc.length && isIdentChar(doc[to])) to++;

  const name = doc.slice(from, to);
  return isIdentifier(name) ? { name, from, to } : null;
}

/** How far either side of a position we read when resolving the identifier
 *  under a pointer or caret. Bounded so a mousemove over a 1 MB buffer costs a
 *  slice, not a full `doc.toString()`. */
const RESOLVE_WINDOW = 256;

/**
 * `identifierAt` over a document we don't want to materialise: reads a window
 * around `pos`, and only widens to the whole document in the rare case where
 * the identifier runs into a window edge that isn't a document edge.
 */
export function identifierNear(
  read: (from: number, to: number) => string,
  docLength: number,
  pos: number,
): { name: string; from: number; to: number } | null {
  const start = Math.max(0, pos - RESOLVE_WINDOW);
  const end = Math.min(docLength, pos + RESOLVE_WINDOW);
  const text = read(start, end);
  const hit = identifierAt(text, pos - start);
  if (!hit) return null;
  if ((hit.from === 0 && start > 0) || (hit.to === text.length && end < docLength)) {
    return identifierAt(read(0, docLength), pos);
  }
  return { name: hit.name, from: hit.from + start, to: hit.to + start };
}

/**
 * Every whole-word occurrence of `name` in `text`, as offsets shifted by
 * `offset`. Whole-word matching is what separates this from find-in-file:
 * standing on `id` must not light up every `width` in the buffer.
 */
export function wordOccurrences(text: string, name: string, offset = 0): SymbolRange[] {
  if (!name) return [];
  const out: SymbolRange[] = [];
  let i = text.indexOf(name);
  while (i !== -1) {
    const before = text[i - 1];
    const after = text[i + name.length];
    if (!isIdentChar(before) && !isIdentChar(after)) {
      out.push({ from: i + offset, to: i + name.length + offset });
    }
    i = text.indexOf(name, i + 1);
  }
  return out;
}

// ── Keywords ──────────────────────────────────────────────────────

/**
 * Words that are never worth highlighting as a symbol. Pooled across every
 * language the editor knows rather than split per language: the cost of
 * over-blocking is that `type` or `record` used as a variable name goes
 * unhighlighted, while the cost of under-blocking is that resting the caret
 * on `return` washes the whole screen.
 */
export const NON_SYMBOL_WORDS = new Set([
  // control flow / shared
  "if", "else", "elif", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "return", "goto", "then", "end", "begin", "loop",
  "try", "catch", "except", "finally", "throw", "throws", "raise", "yield",
  "await", "async", "match", "when", "where", "with", "as", "in", "of",
  "is", "not", "and", "or", "new", "delete", "typeof", "instanceof", "sizeof",
  // declarations
  "function", "func", "fn", "def", "lambda", "class", "struct", "enum",
  "interface", "trait", "impl", "type", "record", "object", "protocol",
  "extension", "union", "namespace", "module", "mod", "package", "import",
  "export", "from", "use", "require", "include", "const", "let", "var",
  "val", "static", "final", "mut", "pub", "public", "private", "protected",
  "internal", "abstract", "virtual", "override", "readonly", "extends",
  "implements", "super", "this", "self", "declare", "unsafe", "extern",
  "inline", "operator", "get", "set", "pass", "defer", "go", "chan",
  // literals & primitives
  "true", "false", "null", "nil", "none", "undefined", "void", "nan",
  "True", "False", "None", "Nil",
  "int", "uint", "long", "short", "byte", "char", "float", "double",
  "bool", "boolean", "string", "str", "number", "any", "unknown", "never",
  "usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64",
]);

/**
 * Is this a name worth painting the ambient occurrence wash for?
 *
 * The AMBIENT layer only — deliberately not the ⌘-click gate. Over-blocking is
 * free here (a keyword simply goes unwashed) and expensive there: every attempt
 * to reuse this pool for navigation silently killed the jump for ordinary
 * identifiers named `use`, `get`, `type` or `record`. Navigation screens on the
 * far narrower `NEVER_DEFINED_WORDS` instead.
 */
export function isNavigableSymbol(name: string): boolean {
  return isIdentifier(name) && !NON_SYMBOL_WORDS.has(name);
}

/**
 * Statement heads that take a parenthesised condition and a block — the only
 * words the `signature` tier below can still mistake for a declaration once the
 * balanced-parenthesis rule has done its work (`if (ready) {` is shaped exactly
 * like `render(props) {`).
 *
 * Kept as small as it can possibly be, and applied only AFTER the `declaration`
 * tier, because every wider version of this list has cost real behaviour:
 * `NON_SYMBOL_WORDS` (the ambient-noise pool, where over-blocking is free) also
 * killed `use`, `get`, `type` and `record`; adding `new`/`delete` killed
 * `pub fn new(…)` and `delete(id) {`. A word here is refused as a SIGNATURE
 * name only — `fn new` still resolves through the declaring keyword in front
 * of it.
 */
export const NEVER_DEFINED_WORDS = new Set([
  "if", "elif", "else", "for", "while", "do", "switch", "case", "catch", "except",
]);

/** Control keywords that can precede a `(` — the reason `if (ok) {` must not
 *  read as a definition of `ok`. */
const CONTROL_BEFORE_PAREN = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "except",
  "return", "yield", "await", "throw", "with", "match", "when", "in", "of",
  "and", "or", "not", "new", "typeof", "instanceof", "assert", "elif",
]);

/**
 * Keywords that DECLARE the identifier that follows them, in every language
 * that has them — the next word is the name, never a type.
 *
 * Deliberately not here: `impl` (`impl Display for Foo` names two types and
 * declares neither), `package` (`package com.acme` names a path), and the
 * modifiers below, which may be followed by a type (`static Integer f()`).
 */
const DECLARING_KEYWORDS = new Set([
  "function", "func", "fn", "fun", "def", "class", "struct", "enum", "interface",
  "trait", "type", "record", "object", "protocol", "union", "namespace",
  "module", "mod", "let", "var", "val", "sub", "proc",
]);

/** Declaring keywords that C also uses to NAME a type in a variable
 *  declaration: `struct Node *next;` declares `next`, not `Node`. */
const TAG_KEYWORDS = new Set(["struct", "enum", "union"]);

/**
 * Modifiers that bind the next word when no type follows — `const total = 1`,
 * `static count = 0`, `readonly id: string` — but sit in front of a TYPE in
 * the C family: `const char *name`, `static String format(…)`.
 */
const BINDING_MODIFIERS = new Set(["const", "static", "readonly", "final"]);

/** Words skipped between a declaring keyword and its name: `let mut x`. */
const BINDING_QUALIFIERS = new Set(["mut", "ref"]);

/** Modifiers a typed declaration may open with. Skipped, never a type. */
const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "final", "abstract",
  "const", "readonly", "volatile", "transient", "synchronized", "native",
  "override", "virtual", "sealed", "extern", "inline", "unsafe", "async",
  "partial", "export", "default", "declare", "open", "suspend", "lateinit",
  "event", "delegate", "register", "unsigned", "signed", "mutable",
  "constexpr", "strictfp", "required", "pub",
]);

/** Primitive and built-in type keywords, which may stand as the type of a
 *  typed declaration even though they are pooled as non-symbols above. */
const TYPE_KEYWORDS = new Set([
  "void", "int", "uint", "long", "short", "byte", "char", "float", "double",
  "bool", "boolean", "string", "object", "decimal", "auto", "dynamic",
]);

/** Words that start a statement, so `return value;` or `puts total` is never
 *  read as "a type, then a name". */
const STATEMENT_WORDS = new Set([
  "return", "throw", "delete", "yield", "await", "goto", "new", "typeof",
  "sizeof", "echo", "print", "puts", "using", "go", "defer", "raise", "del",
  "assert", "import", "package", "include", "require", "else", "case",
]);

const words = (list: string) => list.trim().split(/\s+/);

const C_RESERVED = words(`
  auto break case char const continue default do double else enum extern float
  for goto if inline int long register restrict return short signed sizeof
  static struct switch typedef union unsigned void volatile while
`);

/**
 * Per language: the keywords, primitive types and literals that no workspace
 * declares. Each list holds only what is reserved in THAT language — `val`,
 * `self` and `fn` are keywords in Kotlin, Python and Rust but ordinary names
 * in Go and C. Words a language reserves but still lets code use as a member
 * name stay out (`new`, `delete` and `default` in JavaScript: `map.delete(k)`).
 */
const RESERVED_WORDS: Partial<Record<string, ReadonlySet<string>>> = {
  javascript: new Set(words(`
    break case catch class const continue debugger do else enum export extends
    false finally for function if implements import in instanceof interface let
    null package private protected public return static super switch this throw
    true try typeof var void while with yield await undefined
  `)),
  java: new Set(words(`
    abstract assert boolean break byte case catch char class const continue
    default do double else enum extends final finally float for goto if
    implements import instanceof int interface long native new package private
    protected public return short static strictfp super switch synchronized this
    throw throws transient try void volatile while true false null
  `)),
  rust: new Set(words(`
    as async await break const continue crate dyn else enum extern false fn for
    if impl in let loop match mod move mut pub ref return self Self static struct
    super trait true type unsafe use where while
    bool char str i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64
  `)),
  python: new Set(words(`
    False None True and as assert async await break class continue def del elif
    else except finally for from global if import in is lambda nonlocal not or
    pass raise return try while with yield
  `)),
  go: new Set(words(`
    break case chan const continue default defer else fallthrough for func go
    goto if import interface map package range return select struct switch type
    var true false nil iota bool byte rune int int8 int16 int32 int64 uint uint8
    uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string
  `)),
  c: new Set(C_RESERVED),
  cpp: new Set([
    ...C_RESERVED,
    ...words(`
      alignas alignof asm bool catch class constexpr consteval constinit
      const_cast decltype delete dynamic_cast explicit export false friend
      mutable namespace new noexcept nullptr operator private protected public
      reinterpret_cast static_assert static_cast template this thread_local throw
      true try typeid typename using virtual wchar_t
    `),
  ]),
  csharp: new Set(words(`
    abstract as base bool break byte case catch char checked class const continue
    decimal default delegate do double else enum event explicit extern false
    finally fixed float for foreach goto if implicit in int interface internal is
    lock long namespace new null object operator out override params private
    protected public readonly ref return sbyte sealed short sizeof stackalloc
    static string struct switch this throw true try typeof uint ulong unchecked
    unsafe ushort using virtual void volatile while
  `)),
  kotlin: new Set(words(`
    as break class continue do else false for fun if in interface is null object
    package return super this throw true try typealias typeof val var when while
  `)),
  swift: new Set(words(`
    associatedtype class deinit enum extension fileprivate func import inout
    internal let operator private protocol public rethrows static struct
    subscript typealias var break case continue default defer do else
    fallthrough for guard if in repeat return switch where while as catch false
    is nil super self Self throw throws true try
  `)),
  ruby: new Set(words(`
    alias and begin break case class def do else elsif end ensure false for if
    in module next nil not or redo rescue retry return self super then true undef
    unless until when while yield
  `)),
  lua: new Set(words(`
    and break do else elseif end false for function goto if in local nil not or
    repeat return then true until while
  `)),
};

/**
 * Is `name` part of the language `lang`, so that it never starts a
 * workspace-wide search? Languages without a list fall back to the statement
 * heads in `NEVER_DEFINED_WORDS`.
 */
export function isReservedWord(lang: string | undefined, name: string): boolean {
  return (RESERVED_WORDS[lang ?? ""] ?? NEVER_DEFINED_WORDS).has(name);
}

/** Options for scoring a line of a known language. */
export interface ScoreOptions {
  /**
   * The language writes the type AFTER the name with no separator (Go:
   * `var count int`, `const limit Duration = 5`), so "a word followed by
   * another word" never means the first one is a type.
   */
  typeAfterName?: boolean;
  /**
   * The language writes pointer and reference declarators (C/C++:
   * `char *name`, `struct Node *next`, `int &ref`). Everywhere else a `*` or
   * `&` in front of a name is an operator — `total * rate;` multiplies.
   */
  cDeclarators?: boolean;
}

/** C and C++, by editor language id or by file extension. */
const C_FAMILY = new Set(["c", "cpp", "h", "cc", "cxx", "hpp", "hh", "hxx"]);

/** Go is the one language Octopush highlights that declares `name Type`; C
 *  and C++ are the ones whose declarators carry `*` and `&`. */
export function scoreOptionsFor(langOrExtension: string | undefined): ScoreOptions {
  return {
    typeAfterName: langOrExtension === "go",
    cDeclarators: C_FAMILY.has(langOrExtension ?? ""),
  };
}

// ── Line classification ───────────────────────────────────────────

/** `text` with generic argument lists removed, nested ones included:
 *  `Map<String, List<Int>> m` → `Map m`. */
function stripGenerics(text: string): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out;
}

/** How much of a prefix `wordsBefore` reads. The regex retries from every
 *  start position, so a minified line of thousands of words would cost
 *  quadratic time; the words that matter sit right before the name. */
const WORDS_BEFORE_WINDOW = 160;

/** The bare words at the end of `text`, separated only by whitespace:
 *  `"  for (const "` → `["const"]`, `"pub(crate) fn "` → `["fn"]`. */
function wordsBefore(text: string): string[] {
  const tail = text.slice(-WORDS_BEFORE_WINDOW);
  const m = tail.match(/((?:[A-Za-z_$][A-Za-z0-9_$]*\s+)*)$/);
  const words = m ? m[1].split(/\s+/).filter(Boolean) : [];
  // The window may have cut the first word in half; it isn't one we can read.
  if (tail.length < text.length && m && m.index === 0) words.shift();
  return words;
}

/**
 * Does another identifier follow, making the word in front of `suffix` a TYPE
 * rather than a declared name? `Integer esperaSugerida()`, `char *name`,
 * `List<String> names`, `int[] xs`. Clause words (`extends`, `where`, `of`)
 * don't count: `struct Foo where …` still declares `Foo`.
 */
function followedByName(suffix: string): boolean {
  const m = stripGenerics(suffix).match(/^((?:\[\]|[?*&]|\s)+)([A-Za-z_$][A-Za-z0-9_$]*)/);
  return !!m && !NON_SYMBOL_WORDS.has(m[2]);
}

/** Nothing but whitespace or a trailing comment follows on the line. */
function endsLine(suffix: string): boolean {
  return /^\s*(?:(?:\/\/|\/\*|#).*)?$/.test(suffix);
}

/** Nothing but the rest of a type follows: its type arguments (`<User>`,
 *  `<String, Integer>`), array brackets or a nullable mark, then the line ends
 *  — `public static Optional<User>` ⏎ `find(…)`. */
function endsLineAfterType(suffix: string): boolean {
  return endsLine(stripGenerics(suffix).replace(/^(?:\s*\[\s*\]|\s*\?)+/, ""));
}

/** The score a declaring keyword in front of the name earns: `fn parse`,
 *  `let mut total`, `const limit = 3` — but not `const char *name` (scoring
 *  `char`) or `static Integer f()` (scoring `Integer`), where the word after
 *  the modifier is the declaration's type. */
function keywordDeclaration(prefix: string, suffix: string, opts: ScoreOptions): boolean {
  const words = wordsBefore(stripGenerics(prefix));
  let i = words.length - 1;
  while (i > 0 && BINDING_QUALIFIERS.has(words[i])) i--;
  const keyword = words[i];
  if (keyword === undefined) return false;
  if (DECLARING_KEYWORDS.has(keyword)) {
    return !(TAG_KEYWORDS.has(keyword) && !opts.typeAfterName && followedByName(suffix));
  }
  if (opts.typeAfterName) return BINDING_MODIFIERS.has(keyword);
  // `public static Integer` alone on a line, its name on the next one: with
  // nothing after it, the word after a modifier is the declaration's TYPE as
  // often as its name, so it is never scored as declared.
  if (BINDING_MODIFIERS.has(keyword)) return !followedByName(suffix) && !endsLineAfterType(suffix);
  return false;
}

/** Statement heads whose parenthesis opens a declaration: `for (String s : xs)`,
 *  `catch (IOException e)`, `using (var r = …)`. */
const DECLARING_HEAD_RE = /\b(?:for|foreach|catch|using|try)\s*\(\s*/g;

/**
 * Is the name the declarator of a typed declaration — modifiers, then at most
 * one type, then the name? `private final UserRepository userRepository;`,
 * `@Bean public RestTemplate restTemplate(…) {`, `public string Name { get; }`,
 * `const char *name = …`, `List<String> names = …`.
 *
 * The type in front is never what is declared: it is the identifier the
 * declaration is ABOUT, which is how `public static Integer esperaSugerida()`
 * came to read as a declaration of `Integer`.
 */
function typedDeclaration(prefix: string, suffix: string, opts: ScoreOptions): boolean {
  let head = prefix;
  let inHead = false;
  for (const m of prefix.matchAll(DECLARING_HEAD_RE)) {
    head = prefix.slice((m.index ?? 0) + m[0].length);
    inHead = true;
  }
  // Annotations and attributes: `@Bean`, `@GetMapping("/x")`, `[HttpGet]`.
  head = head.replace(/^\s*(?:(?:@[A-Za-z_$][\w$.]*(?:\([^()]*\))?|\[[^[\]]*\])\s*)+/, "");
  const bare = stripGenerics(head);
  // Operators, separators, calls and bodies all mean this is an expression.
  if (/[=,;()+\-/%|^!~@#\\"'`{}]/.test(bare) || /(^|[^:]):(?!:)/.test(bare)) return false;
  // Outside C/C++ a `*` or `&` is an operator: `total * rate;` multiplies.
  if (!opts.cDeclarators && /[*&]/.test(bare)) return false;

  const tokens = bare
    .split(/\s+/)
    .map((t) => t.replace(/^[*&]+|[*&]+$/g, ""))
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && MODIFIERS.has(tokens[i])) i++;
  // A C typedef names its new type LAST, after a type of any length:
  // `typedef struct node_s node_t;`, `typedef unsigned long size_type;`.
  if (tokens[i] === "typedef") {
    const type = tokens.slice(i + 1).filter((t) => !MODIFIERS.has(t) && !TAG_KEYWORDS.has(t));
    if (type.length === 0 || !type.every(isTypeWord)) return false;
    return declarationEnds(suffix, { type: type[type.length - 1], modified: true, inHead: false });
  }
  const modified = i > 0;
  let rest = tokens.slice(i);
  // `export default App;` re-exports a name declared elsewhere.
  if (rest.length === 0 && tokens.every((t) => t === "export" || t === "default")) return false;
  // C names a tagged type with its keyword: `struct Node *next;`.
  if (rest.length === 2 && TAG_KEYWORDS.has(rest[0])) rest = rest.slice(1);
  if (rest.length > 1) return false;
  const type = rest[0];
  if (type !== undefined) {
    if (!isTypeWord(type)) return false;
  } else if (!modified) {
    return false; // nothing in front of the name: not this shape
  }
  return declarationEnds(suffix, { type, modified, inHead });
}

/** Can `word` stand as the type of a typed declaration? A (qualified) name or
 *  a type keyword — never a statement word, a control word or another keyword. */
function isTypeWord(word: string): boolean {
  if (!/^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*(?:\[\])*\??$/.test(word)) return false;
  if (STATEMENT_WORDS.has(word) || CONTROL_BEFORE_PAREN.has(word)) return false;
  return !NON_SYMBOL_WORDS.has(word) || TYPE_KEYWORDS.has(word);
}

/**
 * Is `line` the dangling head of a declaration whose name sits on the NEXT
 * line — modifiers and at most one type, nothing else? `public static Integer`,
 * `private final UserRepository`, `static int`, GNU C's bare `int`. A lone
 * type with no modifier only counts when it is a type keyword: `Foo` alone on
 * a line is an expression statement in Python or Ruby.
 */
function isDanglingDeclarationHead(line: string, opts: ScoreOptions): boolean {
  if (opts.typeAfterName) return false;
  // Cheap first: statements and bodies are never a head (an annotation line,
  // `@Table(name = "X")` or a C# `[Attr(X = 1)]`, goes the long way).
  if (!/^\s*[@[]/.test(line) && /[=;{}]/.test(line)) return false;
  const head = line.replace(/^\s*(?:(?:@[A-Za-z_$][\w$.]*(?:\([^()]*\))?|\[[^[\]]*\])\s*)+/, "");
  const bare = stripGenerics(head).trim();
  if (bare === "" || /[=,;()+\-/%|^!~@#\\"'`{}:<>]/.test(bare)) return false;
  if (!opts.cDeclarators && /[*&]/.test(bare)) return false;
  const tokens = bare
    .split(/\s+/)
    .map((t) => t.replace(/^[*&]+|(?:\[\]|\?|[*&])+$/g, ""))
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && MODIFIERS.has(tokens[i])) i++;
  let rest = tokens.slice(i);
  if (rest.length === 2 && TAG_KEYWORDS.has(rest[0])) rest = rest.slice(1);
  if (rest.length === 0) return i > 0;
  if (rest.length > 1 || !isTypeWord(rest[0])) return false;
  return i > 0 || TYPE_KEYWORDS.has(rest[0]);
}

/** Does `suffix` close the declaration `typedDeclaration` recognised? */
function declarationEnds(
  suffix: string,
  ctx: { type: string | undefined; modified: boolean; inHead: boolean },
): boolean {
  const typed = ctx.type !== undefined;
  if (/^\s*=>/.test(suffix)) return typed; // C# `int Count => n;`
  if (/^\s*=(?!=)/.test(suffix)) return true; // `Foo foo = …`
  if (/^\s*;/.test(suffix)) return true; // `Foo foo;`
  if (/^\s*\[/.test(suffix)) return typed; // `char buf[64];`
  if (/^\s*\{/.test(suffix)) return typed; // C# `string Name { get; set; }`
  if (/^\??:(?!:)/.test(suffix)) return ctx.modified; // `const MAX: u32`, `private repo?: Repo`
  if (ctx.inHead && typed && /^\s*[:)]/.test(suffix)) return true; // `for (String s : xs)`
  if (/^\s*(<[^<>]*>)?\s*\(/.test(suffix)) return typedParameterList(suffix, ctx);
  // `private final UserRepository userRepository` — but never a lone word after
  // modifiers (`public static Integer`), which is the type of a declaration
  // whose name continues on the next line.
  return endsLine(suffix) && ctx.modified && typed;
}

/** A method or function signature after a typed prefix — the parameter list
 *  either continues on the next line or closes before a body, a `;`, a
 *  `throws` clause or a C# `=>`. */
function typedParameterList(
  suffix: string,
  ctx: { type: string | undefined; modified: boolean },
): boolean {
  const open = suffix.replace(/^\s*(<[^<>]*>)?\s*/, "");
  let depth = 0;
  let close = -1;
  for (let i = 0; i < open.length; i++) {
    if (open[i] === "(") depth++;
    else if (open[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  const typed = ctx.type !== undefined;
  // The list runs on below: `public ResponseEntity<User> create(`.
  if (close === -1) return typed;
  const tail = stripGenerics(open.slice(close + 1)).trim();

  if (!typed) {
    // `static parse(x) {`, `private load(id: string): Promise<User> {` — but
    // never `export default build();`, which is a call.
    return /^(:[^=(){};]*)?\{/.test(tail) || /^:[^=(){};]*;$/.test(tail);
  }
  if (tail === "") {
    // Brace on the next line (`int main(void)` / Allman C#) — but `puts x(y)`
    // reads the same, so ask for a modifier, a type keyword or typed params.
    return ctx.modified || TYPE_KEYWORDS.has(ctx.type!) || hasTypedParameters(open.slice(1, close));
  }
  if (tail.startsWith("=>") || /^where\b/.test(tail)) return true;
  return /^(throws\s+[\w$.]+(\s*,\s*[\w$.]+)*\s*)?((const|override|final|noexcept)\s*)*(\{.*|;|=\s*(0|default|delete)\s*;)$/.test(
    tail,
  );
}

/** `String[] args, final int n` — every parameter carries a type. */
function hasTypedParameters(params: string): boolean {
  const list = stripGenerics(params).trim();
  if (list === "") return false;
  if (list === "void") return true;
  return list
    .split(",")
    .every((p) => !/[:=()"'`]/.test(p) && p.trim().split(/\s+/).length >= 2);
}

/**
 * Can everything before the name be read as modifiers plus a return type?
 *
 * This is the gate that keeps `foo(bar) {` (a definition) apart from
 * `if err := foo(); err != nil {` (a call). It accepts an empty prefix, a Go
 * method receiver, or a short run of bare words — and rejects anything
 * carrying operators, arguments, or member access.
 */
export function isSignaturePrefix(prefix: string): boolean {
  const t = prefix.trim();
  if (t === "") return true;
  // Go method receiver: `func (r *Repo) Name(`.
  if (/^func\s*\([^()]*\)$/.test(t)) return true;
  // Generic arguments are part of a return type, and they legitimately carry
  // commas (`Map<String, Int> get(`) — drop them before the operator scan so
  // one doesn't read as an argument list.
  const bare = t.replace(/<[^<>]*>/g, "").trim();
  // Operators, separators and member access all mean this is an expression.
  if (/[=,;+\-/%|^!?~@#\\"'`]/.test(bare)) return false;
  if (/[.:([{]$/.test(bare) || bare.endsWith("->") || bare.endsWith("::")) return false;
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every(
    (w) =>
      !CONTROL_BEFORE_PAREN.has(w) &&
      // Trailing `*`/`&` so a C or Rust pointer return type still reads as one.
      /^[A-Za-z_$][A-Za-z0-9_$]*[*&]*(\[\])*$/.test(w),
  );
}

/**
 * Does `suffix` open a parameter list that CLOSES on this line, followed by
 * nothing but a return type before the body opens?
 *
 * This is what separates a declaration from a call that happens to end in a
 * brace. `render(props) {` closes its parentheses and then opens a body;
 * `defineConfig({`, `describe("suite", {` and `register(name, {` never close
 * theirs — the brace belongs to an argument. Testing only for "a `(` after the
 * name and a `{` at the end of the line" read all three as declarations, which
 * is how ⌘-click came to answer "declared here" for a plain call.
 */
export function isParameterList(suffix: string): boolean {
  // An optional generic parameter list may sit between the name and the parens.
  const open = suffix.replace(/^\s*(<[^<>]*>)?\s*/, "");
  if (!open.startsWith("(")) return false;
  const offset = suffix.length - open.length;

  let depth = 0;
  let close = -1;
  for (let i = 0; i < open.length; i++) {
    const ch = open[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      close = offset + i;
      break;
    }
  }
  if (close === -1) return false; // never closes on this line → an argument list

  // Between `)` and the body opener: a return type, a throws clause, a Rust
  // `-> T`, a Python `-> T:` — but no second call, no assignment, no literal.
  const tail = suffix.slice(close + 1).replace(/<[^<>]*>/g, "").trim();
  if (!/[{:]$/.test(tail)) return false;
  return !/[()=,;"'`]/.test(tail);
}

/**
 * Score the identifier that starts at `index` on the single line `line`.
 * Returns 0 when the line does not read as a definition of it.
 */
export function scoreDefinitionAt(
  line: string,
  index: number,
  name: string,
  opts: ScoreOptions = {},
): number {
  if (line.slice(index, index + name.length) !== name) return 0;
  if (isIdentChar(line[index - 1]) || isIdentChar(line[index + name.length])) return 0;

  const prefix = line.slice(0, index);
  const suffix = line.slice(index + name.length);
  const trimmedPrefix = prefix.trimEnd();
  const trimmedLine = line.trim();

  // A member access is never a declaration of the member: `a.foo`, `a::foo`.
  if (/[.]$/.test(trimmedPrefix) || trimmedPrefix.endsWith("::") || trimmedPrefix.endsWith("->")) {
    return 0;
  }
  // The quick refusal, before any of the regex work below: no tier declares a
  // name that directly follows an operator, an opening bracket or a separator
  // (`f(x`, `+ x`, `c[x`, `a, x`, `= x`, `{ x`). In a dense file most
  // occurrences of a short name sit exactly there.
  if (/[([{,=+\-/%!|^~<;:@#"'`]$/.test(trimmedPrefix)) return 0;

  // 1 — a declaring keyword immediately in front, or the declarator of a typed
  // declaration. Either way the name is what is declared, never its type.
  if (keywordDeclaration(prefix, suffix, opts)) return DEFINITION_SCORE.declaration;
  if (!opts.typeAfterName && typedDeclaration(prefix, suffix, opts)) {
    return DEFINITION_SCORE.declaration;
  }

  // 2 — a signature that opens a body. Checked AFTER the declaration tier, so a
  // statement head is only ever refused here, never in front of a declaring
  // keyword (`pub fn new(…)` must still resolve).
  if (
    !NEVER_DEFINED_WORDS.has(name) &&
    /[{:]$/.test(trimmedLine) &&
    !trimmedLine.includes("=>") &&
    isSignaturePrefix(prefix) &&
    isParameterList(suffix)
  ) {
    return DEFINITION_SCORE.signature;
  }

  // 3 — a bare binding: `foo = …` / `foo := …`, never `foo == …` or `foo => …`.
  const assigns = /^\s*:?=(?![=>])/.test(suffix);
  // In Go a plain name in front means this word is the TYPE:
  // `const limit Duration = 5`, `StatusOK Status = iota`.
  const before = wordsBefore(prefix);
  const afterName =
    opts.typeAfterName && before.length > 0 && !NON_SYMBOL_WORDS.has(before[before.length - 1]);
  if (assigns && !afterName && !NEVER_DEFINED_WORDS.has(name) && isSignaturePrefix(prefix)) {
    return DEFINITION_SCORE.assignment;
  }

  return 0;
}

/** Convenience for callers holding only a line of text (search hits): the best
 *  score any whole-word occurrence of `name` on that line earns. */
export function scoreDefinitionLine(line: string, name: string, opts: ScoreOptions = {}): number {
  let best = 0;
  for (const r of wordOccurrences(line, name)) {
    best = Math.max(best, scoreDefinitionAt(line, r.from, name, opts));
  }
  return best;
}

/**
 * Every plausible definition of `name` in `doc`, best first (ties broken by
 * position, so the earliest declaration wins — overloads and re-assignments
 * read top-down).
 */
export function findDefinitions(
  doc: string,
  name: string,
  opts: ScoreOptions = {},
): DefinitionSite[] {
  if (!isIdentifier(name)) return [];
  const sites: DefinitionSite[] = [];
  let lineNo = 1;
  let cursor = 0;
  let prevStart = -1;
  while (cursor <= doc.length) {
    let nl = doc.indexOf("\n", cursor);
    if (nl === -1) nl = doc.length;
    const next = doc.indexOf(name, cursor);
    if (next === -1) break;
    if (next >= nl) {
      // Jump straight to the line holding the next occurrence (a rare name in
      // a long file would otherwise rescan to it once per skipped line).
      const lineStart = doc.lastIndexOf("\n", next - 1) + 1;
      for (let i = nl; i !== -1 && i < lineStart; i = doc.indexOf("\n", i + 1)) lineNo++;
      prevStart = lineStart >= 2 ? doc.lastIndexOf("\n", lineStart - 2) + 1 : 0;
      cursor = lineStart;
      continue;
    }
    const line = doc.slice(cursor, nl);
    // A declaration split after its type (`public static Integer` ⏎
    // `esperaSugerida(…) {`) is read as one line: the head, then this one.
    let head: string | null = null;
    if (prevStart >= 0) {
      const prev = doc.slice(prevStart, cursor - 1);
      if (isDanglingDeclarationHead(prev, opts)) head = prev.trim() + " ";
    }
    const indent = line.length - line.trimStart().length;
    const joined = head === null ? "" : head + line.slice(indent);
    for (const r of wordOccurrences(line, name)) {
      let score = scoreDefinitionAt(line, r.from, name, opts);
      if (head !== null) {
        score = Math.max(score, scoreDefinitionAt(joined, head.length + r.from - indent, name, opts));
      }
      if (score > 0) {
        sites.push({ from: cursor + r.from, to: cursor + r.to, line: lineNo, score });
      }
    }
    prevStart = cursor;
    cursor = nl + 1;
    lineNo++;
  }
  sites.sort((a, b) => b.score - a.score || a.from - b.from);
  return sites;
}

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
 *                      `class Foo`, `type Foo`, `struct Foo`, …
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

/** Control keywords that can precede a `(` — the reason `if (ok) {` must not
 *  read as a definition of `ok`. */
const CONTROL_BEFORE_PAREN = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "except",
  "return", "yield", "await", "throw", "with", "match", "when", "in", "of",
  "and", "or", "not", "new", "typeof", "instanceof", "assert", "elif",
]);

/** Keywords that DECLARE the identifier that follows them. */
const DECLARING_KEYWORDS = new Set([
  "function", "func", "fn", "def", "class", "struct", "enum", "interface",
  "trait", "type", "record", "object", "protocol", "union", "namespace",
  "module", "mod", "package", "const", "let", "var", "val", "static",
  "declare", "impl", "sub", "proc", "constructor", "property", "event",
  "delegate", "operator",
]);

// ── Line classification ───────────────────────────────────────────

/** The identifier-ish word ending at the end of `text`, or "". */
function trailingWord(text: string): string {
  const m = text.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
  return m ? m[1] : "";
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
 * Score the identifier that starts at `index` on the single line `line`.
 * Returns 0 when the line does not read as a definition of it.
 */
export function scoreDefinitionAt(line: string, index: number, name: string): number {
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

  // 1 — a declaring keyword immediately in front.
  if (DECLARING_KEYWORDS.has(trailingWord(prefix))) return DEFINITION_SCORE.declaration;

  // 2 — a signature that opens a body. The `=>` veto is what stops a callback
  // (`describe("x", () => {`) from reading as a definition of `describe`.
  const opensBody = /[{:]$/.test(trimmedLine);
  const paramList = /^\s*(<[^<>]*>)?\s*\(/.test(suffix);
  if (opensBody && paramList && !trimmedLine.includes("=>") && isSignaturePrefix(prefix)) {
    return DEFINITION_SCORE.signature;
  }

  // 3 — a bare binding: `foo = …` / `foo := …`, never `foo == …` or `foo => …`.
  const assigns = /^\s*:?=(?![=>])/.test(suffix);
  if (assigns && isSignaturePrefix(prefix)) return DEFINITION_SCORE.assignment;

  return 0;
}

/** Convenience for callers holding only a line of text (search hits): the best
 *  score any whole-word occurrence of `name` on that line earns. */
export function scoreDefinitionLine(line: string, name: string): number {
  let best = 0;
  for (const r of wordOccurrences(line, name)) {
    best = Math.max(best, scoreDefinitionAt(line, r.from, name));
  }
  return best;
}

/**
 * Every plausible definition of `name` in `doc`, best first (ties broken by
 * position, so the earliest declaration wins — overloads and re-assignments
 * read top-down).
 */
export function findDefinitions(doc: string, name: string): DefinitionSite[] {
  if (!isIdentifier(name)) return [];
  const sites: DefinitionSite[] = [];
  let lineNo = 1;
  let cursor = 0;
  while (cursor <= doc.length) {
    let nl = doc.indexOf("\n", cursor);
    if (nl === -1) nl = doc.length;
    const line = doc.slice(cursor, nl);
    if (line.includes(name)) {
      for (const r of wordOccurrences(line, name)) {
        const score = scoreDefinitionAt(line, r.from, name);
        if (score > 0) {
          sites.push({ from: cursor + r.from, to: cursor + r.to, line: lineNo, score });
        }
      }
    }
    cursor = nl + 1;
    lineNo++;
  }
  sites.sort((a, b) => b.score - a.score || a.from - b.from);
  return sites;
}

/**
 * diffSyntax — class-based syntax highlighting for the Review diff.
 *
 * Uses CodeMirror's highlightTree with a class-only HighlightStyle so
 * colors come from CSS (.tok-kw, .tok-num, …) rather than inline style.
 *
 * Lines are highlighted in context, never one at a time: each side of a
 * file (old and new) is parsed as one document and the tokens are mapped
 * back onto the diff rows, so a line inside a block comment, a docstring
 * or a multi-line string is coloured as such. The language set is the
 * editor's (`editorLanguages.ts`), stream modes included.
 *
 * Highlighting is synchronous and uses only grammars that have already
 * loaded; a file whose grammar is still in flight reads as plain text.
 * Callers start the load with `loadDiffGrammar` (FileDiffSection does on
 * mount) and highlight again when it resolves — on a warm cache it is
 * already there and the first render is coloured.
 *
 * Supersedes `diffHighlight.ts` (per-line, Lezer-only), which no longer has
 * callers.
 */
import { highlightTree } from "@lezer/highlight";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { langForExtension, type LangId } from "./editorLang";
import { loadLanguage, loadedLanguage } from "./editorLanguages";
import type { DiffFile, DiffRow } from "./diffParser";
import type { WordSegment } from "./wordDiff";

export interface DiffTok { text: string; cls: string; }

/**
 * Class-only HighlightStyle — mirrors the atelierTheme palette (tag for
 * tag, so the diff colours what the editor colours) but emits CSS class
 * names instead of inline style properties.
 * Colors are defined in src/styles.css as .tok-* rules.
 */
const classStyle = HighlightStyle.define([
  { tag: t.keyword,           class: "tok-kw" },
  { tag: t.controlKeyword,    class: "tok-kw" },
  { tag: t.definitionKeyword, class: "tok-kw" },
  { tag: t.moduleKeyword,     class: "tok-kw" },
  { tag: t.operatorKeyword,   class: "tok-kw" },
  { tag: t.bool,              class: "tok-kw" },
  { tag: t.heading,           class: "tok-kw" },

  { tag: t.string,                 class: "tok-str" },
  { tag: t.special(t.string),      class: "tok-str" },
  { tag: t.regexp,                 class: "tok-str" },
  { tag: t.escape,                 class: "tok-str" },
  { tag: t.attributeValue,         class: "tok-str" },
  { tag: t.link,                   class: "tok-str" },

  { tag: t.number,   class: "tok-num" },
  { tag: t.integer,  class: "tok-num" },
  { tag: t.float,    class: "tok-num" },

  { tag: t.comment,      class: "tok-cmt" },
  { tag: t.lineComment,  class: "tok-cmt" },
  { tag: t.blockComment, class: "tok-cmt" },
  { tag: t.null,         class: "tok-cmt" },
  { tag: t.meta,         class: "tok-cmt" },
  { tag: t.processingInstruction, class: "tok-cmt" },

  { tag: t.typeName,  class: "tok-type" },
  { tag: t.className, class: "tok-type" },
  { tag: t.namespace, class: "tok-type" },
  { tag: t.tagName,   class: "tok-type" },

  { tag: t.function(t.variableName), class: "tok-fn" },
  { tag: t.function(t.propertyName), class: "tok-fn" },

  { tag: t.operator,      class: "tok-op" },
  { tag: t.punctuation,   class: "tok-op" },
  { tag: t.angleBracket,  class: "tok-op" },
  { tag: t.attributeName, class: "tok-op" },

  { tag: t.variableName, class: "tok-var" },
  { tag: t.propertyName, class: "tok-var" },
]);

const plain = (text: string): DiffTok[] => [{ text, cls: "" }];

/** Has the grammar `filePath` is highlighted with landed (plain text counts)? */
export function diffGrammarReady(filePath: string): boolean {
  return loadedLanguage(langForExtension(filePath)) !== undefined;
}

/** Fetch the grammar `filePath` is highlighted with. Resolves once
 *  `diffGrammarReady` holds, or the load failed (the file stays plain). */
export function loadDiffGrammar(filePath: string): Promise<void> {
  return loadLanguage(langForExtension(filePath)).then(() => {});
}

// Memoize by (langId, document): diff rows re-render often (focus changes,
// etc.), and the same file version is highlighted again after a remount.
// Bounded so it can't grow without limit across long-lived sessions.
const MEMO_LIMIT = 200;
const memo = new Map<string, DiffTok[][]>();

/**
 * Highlight `lines` as ONE document (joined with "\n") and return the
 * tokens of each line. Every line's tokens concatenate to it exactly
 * (round-trip guarantee); tokens with no applicable class have `cls: ""`.
 * Unknown / plaintext languages, and grammars not loaded yet, give one
 * unclassed token per line.
 */
export function highlightLines(lines: string[], langId: LangId): DiffTok[][] {
  const lang = loadedLanguage(langId);
  if (!lang) return lines.map(plain);

  const doc = lines.join("\n");
  const key = `${langId}\n${doc}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const out: DiffTok[][] = lines.map(() => []);
  let line = 0;
  // A token may span lines (block comment, docstring): split it at "\n".
  const emit = (text: string, cls: string) => {
    text.split("\n").forEach((part, i) => {
      if (i > 0) line++;
      if (part) out[line].push({ text: part, cls });
    });
  };

  let pos = 0;
  highlightTree(lang.parser.parse(doc), classStyle, (from, to, cls) => {
    if (from > pos) emit(doc.slice(pos, from), "");
    emit(doc.slice(from, to), cls);
    pos = to;
  });
  if (pos < doc.length) emit(doc.slice(pos), "");

  const result = out.map((toks, i) => (toks.length ? toks : plain(lines[i])));
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, result);
  return result;
}

/** Tokenise one line as if it belongs to `filePath` (no context). */
export function highlightLine(text: string, filePath: string): DiffTok[] {
  if (!text) return plain(text);
  return highlightLines([text], langForExtension(filePath))[0];
}

/**
 * Highlight one hunk in context: its old side (context + deleted rows) and
 * its new side (context + added rows) are each parsed as one document.
 * Returns the tokens of each row, parallel to `rows`.
 */
export function highlightHunk(rows: DiffRow[], filePath: string): DiffTok[][] {
  const langId = langForExtension(filePath);
  const oldToks = highlightLines(rows.filter((r) => r.kind !== "add").map((r) => r.text), langId);
  const newToks = highlightLines(rows.filter((r) => r.kind !== "del").map((r) => r.text), langId);
  let o = 0, n = 0;
  return rows.map((r) => {
    if (r.kind === "del") return oldToks[o++];
    if (r.kind === "context") o++;
    return newToks[n++];
  });
}

/**
 * Highlight a whole file diff. With `newContent` (the file as on disk) both
 * sides are rebuilt up to the end of the last hunk — the old side by
 * reverse-applying the hunks — so a hunk that opens inside a Javadoc or a
 * docstring still sees its opener. Without it, or when the content no longer
 * matches the diff, each hunk is highlighted in its own context.
 * Returns tokens per hunk, per row.
 */
export function highlightFile(file: DiffFile, newContent: string | null): DiffTok[][][] {
  const langId = langForExtension(file.filePath);
  if (!loadedLanguage(langId)) return file.hunks.map((h) => h.rows.map((r) => plain(r.text)));

  const sides = newContent == null ? null : rebuildSides(file, newContent);
  if (!sides) return file.hunks.map((h) => highlightHunk(h.rows, file.filePath));

  const oldToks = highlightLines(sides.old, langId);
  const newToks = highlightLines(sides.new, langId);
  return file.hunks.map((h) =>
    h.rows.map((r) => (r.kind === "del" ? oldToks[r.oldLine! - 1] : newToks[r.newLine! - 1])),
  );
}

/**
 * Both sides of a file, from line 1 to the end of its last hunk. Lines
 * between hunks are unchanged, so both sides take them from `newContent`.
 * Null when `newContent` doesn't match the diff (the file moved on since).
 */
export function rebuildSides(file: DiffFile, newContent: string): { old: string[]; new: string[] } | null {
  const cur = newContent.split("\n");
  const oldL: string[] = [];
  const newL: string[] = [];
  let next = 0; // index in `cur` of the next line not yet copied

  for (const hunk of file.hunks) {
    const m = hunk.header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) return null;
    const newStart = parseInt(m[1], 10);
    // A hunk with no new lines ("+N,0") sits after line N.
    const start = m[2] === "0" ? newStart : newStart - 1;
    if (start < next || start > cur.length) return null;
    while (next < start) { oldL.push(cur[next]); newL.push(cur[next]); next++; }

    for (const r of hunk.rows) {
      if (r.kind !== "del") {
        if (cur[next] !== r.text) return null;
        newL.push(r.text);
        next++;
        if (r.newLine !== newL.length) return null;
      }
      if (r.kind !== "add") {
        oldL.push(r.text);
        if (r.oldLine !== oldL.length) return null;
      }
    }
  }
  return { old: oldL, new: newL };
}

/**
 * Lay word-diff segments over syntax tokens: each piece keeps its syntax
 * class and gains `wd-add` / `wd-del` where the word changed.
 */
export function overlaySegments(toks: DiffTok[], segments: WordSegment[]): DiffTok[] {
  const out: DiffTok[] = [];
  let ti = 0, off = 0;
  for (const seg of segments) {
    const mark = seg.kind === "equal" ? "" : seg.kind === "add" ? "wd-add" : "wd-del";
    let left = seg.text.length;
    while (left > 0 && ti < toks.length) {
      const tok = toks[ti];
      const take = Math.min(left, tok.text.length - off);
      out.push({ text: tok.text.slice(off, off + take), cls: [tok.cls, mark].filter(Boolean).join(" ") });
      left -= take;
      off += take;
      if (off >= tok.text.length) { ti++; off = 0; }
    }
    // Segments running past the tokens (row text changed under us) keep their text.
    if (left > 0) out.push({ text: seg.text.slice(seg.text.length - left), cls: mark });
  }
  return out;
}

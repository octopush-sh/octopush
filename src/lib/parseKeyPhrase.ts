// Splits assistant content into a lead "key phrase" (rendered as Spectral
// upright serif display) and a body (rendered as markdown).
//
// Returns `keyPhrase: null` when the parse should be skipped — content
// starts with block markdown (code fence, heading, list, quote, table), the
// first line has no sentence end, there is no body after the lead, the lead
// is too long, or the lead carries anything but plain prose and inline code.
//
// See docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md §4.3.

export interface KeyPhraseSplit {
  keyPhrase: string | null;
  body: string;
}

const MAX_KEY_PHRASE_LEN = 160;

const TERMINATORS = ".!?";

/** What may close a sentence after its terminator: `(It works.)`, `"Done."`. */
const CLOSERS = ")]\"'”’»";

/** Words whose last dot belongs to the word, lower-cased and without that
 *  dot. A dot after one of them never ends the lead: "Use a tool, e.g. rg." */
const ABBREVIATIONS = new Set(["e.g", "eg", "i.e", "ie", "etc", "vs", "cf", "approx", "incl", "esp", "viz", "a.k.a"]);

/** Where a URL begins: a scheme (`https://`), `www.` or `mailto:`. A URL runs
 *  to the next whitespace, and nothing inside it ends a sentence. */
const URL_START_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i;

/** A URL anywhere in the lead: a scheme, `www.`, `mailto:`, an email, or a
 *  domain followed by a path (`github.com/acme/api`). GFM turns most of these
 *  into links, and a long address is not a display phrase anyway. */
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+(?:\.[\w-]+)+\//i;

/** Markdown the serif line must never carry, checked with the code spans
 *  taken out: link and image brackets, emphasis and strong (`*`, `_`), a
 *  strikethrough pair (`~x~` strikes in GFM too), and HTML or autolinks. */
const MARKDOWN_RE = /[[\]*_]|~[^~]*~|<[a-z/!?]/i;

/** Content that opens with block markdown never has a lead. */
function opensWithBlock(text: string): boolean {
  return (
    text.startsWith("```") ||
    text.startsWith("~~~") ||
    text.startsWith("#") ||
    text.startsWith(">") ||
    text.startsWith("|") ||
    text.startsWith("- ") ||
    text.startsWith("* ") ||
    text.startsWith("+ ") ||
    /^\d+[.)]\s/.test(text)
  );
}

/** The index just past the inline code span that opens at `start` (a run of
 *  backticks closed by a run of the same length on the same line), or -1
 *  when it isn't closed there. */
function codeSpanEnd(text: string, start: number): number {
  let open = start;
  while (text[open] === "`") open++;
  const ticks = open - start;
  let i = open;
  while (i < text.length && text[i] !== "\n") {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let run = i;
    while (text[run] === "`") run++;
    if (run - i === ticks) return run;
    i = run;
  }
  return -1;
}

/** The index just past the bracket pair that opens at `start` (on the same
 *  line, nesting counted), or -1 when it doesn't close. */
function bracketEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length && text[i] !== "\n"; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** The index just past a markdown link at `start` (`[text](url)`,
 *  `[text][ref]` or a bare `[text]`), or -1 when the bracket doesn't close. */
function linkEnd(text: string, start: number): number {
  const label = bracketEnd(text, start, "[", "]");
  if (label < 0) return -1;
  if (text[label] === "(") {
    const target = bracketEnd(text, label, "(", ")");
    return target < 0 ? label : target;
  }
  if (text[label] === "[") {
    const ref = bracketEnd(text, label, "[", "]");
    return ref < 0 ? label : ref;
  }
  return label;
}

/** Whether the dot at `dot` closes an abbreviation such as `e.g.` or `etc.`. */
function isAbbreviation(text: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) start--;
  return ABBREVIATIONS.has(text.slice(start, dot).toLowerCase());
}

/** The index just past the first sentence on `text`'s first line, or -1 when
 *  that line has none. A terminator (`.`, `!`, `?`, or a run of them) ends
 *  the sentence only when whitespace or the end of the text follows it, so
 *  `v0.4.141`, `3.5`, `index.ts` and `github.com` never split. Nothing inside
 *  inline code, a markdown link or a URL ends a sentence; an ellipsis trails
 *  off rather than ends it, and neither does an abbreviation's dot. */
function firstSentenceEnd(text: string): number {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // The lead sits on the first line: a line break before any sentence end
    // means the first line isn't a sentence.
    if (ch === "\n") return -1;
    if (ch === "`") {
      const end = codeSpanEnd(text, i);
      // An open code span is still streaming, or isn't code at all: either
      // way, no lead until it reads as one.
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === "[") {
      const end = linkEnd(text, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if ((i === 0 || /\W/.test(text[i - 1])) && URL_START_RE.test(text.slice(i, i + 16))) {
      while (i < text.length && !/\s/.test(text[i])) i++;
      continue;
    }
    if (TERMINATORS.includes(ch)) {
      let end = i;
      while (end < text.length && TERMINATORS.includes(text[end])) end++;
      const run = text.slice(i, end);
      while (end < text.length && CLOSERS.includes(text[end])) end++;
      const atBoundary = end === text.length || /\s/.test(text[end]);
      const ellipsis = run.includes("..");
      if (atBoundary && !ellipsis && !(run === "." && isAbbreviation(text, i))) return end;
      i = end;
      continue;
    }
    i++;
  }
  return -1;
}

/** `text` with its inline code spans taken out. */
function withoutCodeSpans(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Whether `lead` is plain prose (inline code allowed), the only thing
 *  ChatMessage sets as the serif line: never a link, an emphasis mark or a
 *  URL, which would show as raw syntax or as a link styled as display type. */
function isPlainLead(lead: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(lead)) return false;
  if (URL_RE.test(lead)) return false;
  return !MARKDOWN_RE.test(withoutCodeSpans(lead));
}

export function parseKeyPhrase(content: string): KeyPhraseSplit {
  const trimmed = content.trim();
  const none: KeyPhraseSplit = { keyPhrase: null, body: trimmed };

  if (opensWithBlock(trimmed)) return none;

  // A lead longer than the cap is rejected anyway, so scan only that far:
  // the scan is linear per bracket and a long first line could cost seconds
  // while a reply streams.
  const end = firstSentenceEnd(trimmed.slice(0, MAX_KEY_PHRASE_LEN + 2));
  if (end < 0) return none;

  const lead = trimmed.slice(0, end).trim();
  const rest = trimmed.slice(end).trim();

  if (lead.length > MAX_KEY_PHRASE_LEN) return none;

  // Nothing after the lead — don't elevate a single sentence.
  if (rest.length === 0) return none;

  if (!isPlainLead(lead)) return none;

  return { keyPhrase: lead, body: rest };
}

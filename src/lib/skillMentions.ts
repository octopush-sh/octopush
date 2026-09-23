/**
 * Pure helpers for `/skill` mentions in the composer — the same shape as
 * `@file` mentions: a `/` at line start or after whitespace, followed by a
 * skill name. A message may carry several; each rides along with THAT
 * message only (the backend resolves the tokens against the worktree's
 * skills when the turn runs — a hand-typed `/code-review` works exactly like
 * one picked from the menu). Nothing is pinned to the conversation.
 *
 * Boundary rules mirror `skills::mentions_skill` on the backend: the token
 * must stand alone — `/code-review` matches, `/code-review-notes` and
 * `src/code-review` do not.
 */

/** Characters that continue a word around a token (a path segment, a longer
 *  slug): the same set the backend uses, so both sides agree on what is a
 *  standalone `/name`. */
const WORD_CHAR = /[\p{L}\p{N}\-_./]/u;

/** The `/query` immediately left of the caret, with no whitespace between
 *  the `/` and the caret and the `/` at line start or after whitespace (or an
 *  opening delimiter). Null when the caret is not inside a trigger. A `/`
 *  glued to a word (`src/lib`) is a path, not a trigger. */
export function findActiveSkillMention(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "/") {
      const prev = i > 0 ? text[i - 1] : " ";
      if (i === 0 || /[\s([{"'`]/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (/\s/.test(query)) return null;
        return { query, start: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** Replace the active `/query` (from `start` to `caret`) with `/name ` and
 *  return the new text + the caret position after it. */
export function applySkillMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const insert = `/${name} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

/** One standalone `/name` token in a text, by character range. */
export interface SkillToken {
  name: string;
  start: number;
  /** Exclusive end. */
  end: number;
}

/** The `[start, end)` ranges of fenced code blocks (``` … ```), including
 *  the fence lines. Text inside a fence is content, never an invocation:
 *  an `@file` expansion pastes the file as a fenced block, and a
 *  CHANGELOG line saying "run /release" must not invoke the skill. Mirrors
 *  `skills::outside_fences` on the backend. */
export function fencedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  const lineRe = /^[ \t]*```/gmu;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const lineEnd = text.indexOf("\n", m.index);
    if (open === null) {
      open = m.index;
    } else {
      out.push([open, lineEnd === -1 ? text.length : lineEnd + 1]);
      open = null;
    }
    lineRe.lastIndex = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  if (open !== null) out.push([open, text.length]); // an unclosed fence runs to the end
  return out;
}

/** Every standalone `/name` token whose name is a known skill, in text
 *  order — fenced code excluded. Drives both the composer's inline
 *  highlight and the sent message's chips. */
export function skillTokens(text: string, known: Iterable<string>): SkillToken[] {
  const names = new Set(known);
  if (names.size === 0) return [];
  const fences = fencedRanges(text);
  const out: SkillToken[] = [];
  const re = /\/([\p{L}\p{N}\-_.]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (fences.some(([a, b]) => start >= a && start < b)) continue; // code, not an invocation
    // A trailing period is punctuation, not part of the name (`/release.`
    // ends a sentence; `/release.md` is a file and stays a longer word).
    const name = m[1].replace(/\.+$/, "");
    if (name.length === 0) continue;
    const before = start > 0 ? text[start - 1] : "";
    if (before && WORD_CHAR.test(before)) continue; // a path segment
    const end = start + 1 + name.length;
    const after = text[end] ?? "";
    const afterAfter = text[end + 1] ?? "";
    // A longer word continues the token — except a sentence-ending period.
    const periodEndsSentence = after === "." && !(afterAfter && WORD_CHAR.test(afterAfter));
    const continues = after !== "" && WORD_CHAR.test(after) && !periodEndsSentence;
    if (continues) continue;
    if (!names.has(name)) continue;
    out.push({ name, start, end });
  }
  return out;
}

/** The unique skill names a message invokes, in order of first mention. */
export function extractSkillMentions(text: string, known: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of skillTokens(text, known)) {
    if (!out.includes(t.name)) out.push(t.name);
  }
  return out;
}

/** Split a text into plain runs and skill tokens, for rendering. */
export function splitBySkillTokens(
  text: string,
  known: Iterable<string>,
): Array<{ kind: "text"; text: string } | { kind: "skill"; name: string; text: string }> {
  const parts: Array<{ kind: "text"; text: string } | { kind: "skill"; name: string; text: string }> = [];
  let cursor = 0;
  for (const t of skillTokens(text, known)) {
    if (t.start > cursor) parts.push({ kind: "text", text: text.slice(cursor, t.start) });
    parts.push({ kind: "skill", name: t.name, text: text.slice(t.start, t.end) });
    cursor = t.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}

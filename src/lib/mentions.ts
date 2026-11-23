/**
 * Pure helpers for `@file` mentions in the composer. Kept separate from the
 * React component so the matching/ranking/extraction logic is unit-testable.
 *
 * A mention is `@` (at line start or after whitespace) followed by a run of
 * non-whitespace characters — the worktree-relative file path.
 */

/** The active mention being typed: the `@token` immediately left of the caret,
 *  with no whitespace between the `@` and the caret. Returns null when the
 *  caret isn't inside a mention trigger. */
export function findActiveMention(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const prev = i > 0 ? text[i - 1] : " ";
      // Trigger at line start, after whitespace, or after a common opening
      // delimiter ( [ { " ' so `(@foo` and `"@foo` also autocomplete.
      if (i === 0 || /[\s([{"'`]/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (/\s/.test(query)) return null; // mention ends at whitespace
        return { query, start: i };
      }
      return null; // '@' glued to a word (e.g. an email) — not a trigger
    }
    if (/\s/.test(ch)) return null; // whitespace before any '@'
  }
  return null;
}

/** Trailing characters that commonly follow a mention in prose but aren't part
 *  of a path, stripped before matching against the known-files set. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"`]+$/;

/** Subsequence test: are all chars of `q` present in `s` in order? */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Rank worktree files for a query. Basename hits rank above path hits; exact
 *  prefix above substring above subsequence; shorter paths break ties. Empty
 *  query returns the first `limit` files unchanged. */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: { p: string; score: number }[] = [];
  for (const p of files) {
    const lower = p.toLowerCase();
    // A folder entry (`src/lib/`) ranks by its own name, not the empty tail.
    const bare = lower.endsWith("/") ? lower.slice(0, -1) : lower;
    const base = bare.slice(bare.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    if (score >= 0) scored.push({ p, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.p.length - b.p.length || a.p.localeCompare(b.p),
  );
  return scored.slice(0, limit).map((s) => s.p);
}

/** Extract unique mentioned paths from a composed message, keeping only those
 *  that match a known worktree file (so stray `@handles` are ignored). */
export function extractMentions(text: string, knownFiles: Set<string>): string[] {
  const out: string[] = [];
  // Allow `@` at line start, after whitespace, or after an opening delimiter.
  const re = /(?:^|[\s([{"'`])@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // The token may carry trailing prose punctuation (e.g. `@foo.ts.`); try the
    // raw token first, then a punctuation-stripped form, against the catalog.
    const stripped = raw.replace(TRAILING_PUNCT, "");
    const path = knownFiles.has(raw) ? raw : knownFiles.has(stripped) ? stripped : null;
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Replace the active `@query` (from `start` to `caret`) with `@path ` and
 *  return the new text + the caret position after it. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const insert = `@${path} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

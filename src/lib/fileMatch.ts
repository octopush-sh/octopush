/**
 * fileMatch — the ⌘P file finder's matcher. Pure; no React, no IPC.
 *
 * A query is one of:
 *   - a **glob** (contains `*`, `?` or `[`): without a `/` it matches the
 *     file name (`*.java`, `User*Test.kt`); with a `/` it matches the whole
 *     path (`src/**\/*.ts`, where `**\/` spans zero or more directories);
 *   - **fuzzy** terms separated by spaces, all of which must match, scored
 *     fzf-style: bonuses for matching in the file name, at word / camel-case
 *     boundaries and in consecutive runs, penalties for gaps.
 *
 * Either may end in `:line` or `:line:col`, which is split off and opens the
 * file at that position. A leading `./` and the absolute workspace root are
 * stripped so pasted paths match. Smart case: an all-lowercase query ignores
 * case, any capital makes it case-sensitive.
 *
 * Equal scores fall back to the caller's `boost` order (open tabs, recently
 * opened files), then to the shorter path, then alphabetical.
 */

/** Matches `list_workspace_files`' FILE_LIST_CAP in `commands.rs`. */
export const FILE_LIST_CAP = 20_000;

export interface ParsedQuery {
  kind: "empty" | "glob" | "fuzzy";
  /** The glob pattern, or the fuzzy text with `:line[:col]` removed. */
  text: string;
  /** Fuzzy terms (space-separated); empty for a glob. */
  terms: string[];
  caseSensitive: boolean;
  line?: number;
  col?: number;
}

/** A file prepared once per listing, so each keystroke only scans. */
export interface PreparedFile {
  path: string;
  lower: string;
  /** Index where the file name starts (after the last `/`). */
  nameStart: number;
}

export interface FileMatch {
  path: string;
  score: number;
}

export function prepareFiles(paths: string[]): PreparedFile[] {
  return paths.map((path) => ({
    path,
    lower: path.toLowerCase(),
    nameStart: path.lastIndexOf("/") + 1,
  }));
}

const GLOB_CHARS = /[*?[]/;
const POSITION = /:(\d+)(?::(\d+))?$/;

/** Strip `./` and the workspace root so pasted paths match relative ones. */
export function normalizeQuery(raw: string, workspacePath = ""): string {
  let q = raw.trim();
  const root = workspacePath.replace(/\/+$/, "");
  if (root && (q === root || q.startsWith(root + "/"))) q = q.slice(root.length);
  q = q.replace(/^\/+/, "");
  while (q.startsWith("./")) q = q.slice(2);
  return q;
}

export function parseQuery(raw: string, workspacePath = ""): ParsedQuery {
  let text = normalizeQuery(raw, workspacePath);
  let line: number | undefined;
  let col: number | undefined;
  const pos = POSITION.exec(text);
  if (pos) {
    line = Math.max(1, Number(pos[1]));
    if (pos[2] !== undefined) col = Math.max(1, Number(pos[2]));
    text = text.slice(0, pos.index);
  }
  const caseSensitive = text !== text.toLowerCase();
  const base = { text, caseSensitive, line, col };
  if (!text) return { ...base, kind: "empty", terms: [] };
  if (GLOB_CHARS.test(text)) return { ...base, kind: "glob", terms: [] };
  return { ...base, kind: "fuzzy", terms: text.split(/\s+/).filter(Boolean) };
}

// ─── Globs ─────────────────────────────────────────────────────────

/** Compile a glob to an anchored RegExp. `*` and `?` never cross `/`;
 *  `**` does, and `**\/` also matches no directory at all. */
export function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const negate = body[0] === "!" || body[0] === "^";
      if (negate) body = body.slice(1);
      body = body.replace(/[\\\]^]/g, "\\$&");
      re += negate ? `[^/${body}]` : `[${body}]`;
      i = close;
    } else {
      re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, caseSensitive ? "" : "i");
}

// ─── Fuzzy scoring ─────────────────────────────────────────────────

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 9;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 5;
const FIRST_CHAR_MULTIPLIER = 2;
/** A term that fits in the file name outranks one that needs directories. */
const BONUS_FILE_NAME = 24;

const isLower = (c: string) => c >= "a" && c <= "z";
const isUpper = (c: string) => c >= "A" && c <= "Z";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isWordChar = (c: string) => isLower(c) || isUpper(c) || isDigit(c);

/** The bonus for a match at `i`: start of the text, after a separator, or a
 *  lower→upper / letter→digit transition. */
function boundaryBonus(text: string, i: number, from: number): number {
  if (i === from) return BONUS_BOUNDARY;
  const prev = text[i - 1];
  const cur = text[i];
  if (!isWordChar(prev)) return BONUS_BOUNDARY;
  if (isLower(prev) && isUpper(cur)) return BONUS_CAMEL;
  if (!isDigit(prev) && isDigit(cur)) return BONUS_CAMEL;
  return 0;
}

/**
 * Score `term` against `text[from..]` (fzf's v1 shape, linear time): find
 * the first in-order match ending as early as possible, walk back from its
 * end for the tightest start, then score that window greedily. `null` when
 * the term isn't a subsequence.
 */
export function scoreTerm(
  text: string,
  hay: string,
  term: string,
  from = 0,
): number | null {
  const n = hay.length;
  const m = term.length;
  if (m === 0) return 0;
  let ti = 0;
  let end = -1;
  for (let i = from; i < n; i++) {
    if (hay[i] === term[ti] && ++ti === m) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  for (let i = end, k = m - 1; i >= from; i--) {
    if (hay[i] === term[k]) {
      start = i;
      if (--k < 0) break;
    }
  }

  let score = 0;
  let k = 0;
  let inGap = false;
  let runBonus = 0;
  let prevMatched = false;
  for (let i = start; i <= end && k < m; i++) {
    if (hay[i] === term[k]) {
      let bonus = boundaryBonus(text, i, from);
      if (prevMatched) {
        // A run keeps the boundary bonus it started on (fzf), at least the
        // consecutive bonus.
        runBonus = Math.max(runBonus, bonus, BONUS_CONSECUTIVE);
        bonus = runBonus;
      } else {
        runBonus = bonus;
      }
      score += SCORE_MATCH + (k === 0 ? bonus * FIRST_CHAR_MULTIPLIER : bonus);
      k++;
      prevMatched = true;
      inGap = false;
    } else {
      score += inGap ? GAP_EXTENSION : GAP_START;
      inGap = true;
      prevMatched = false;
    }
  }
  return score;
}

/** Score one file against all terms; `null` if any term misses. */
function scoreFile(file: PreparedFile, terms: string[], caseSensitive: boolean): number | null {
  const hay = caseSensitive ? file.path : file.lower;
  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    if (!term.includes("/")) {
      const inName = scoreTerm(file.path, hay, term, file.nameStart);
      if (inName !== null) best = inName + BONUS_FILE_NAME;
    }
    if (best === null) best = scoreTerm(file.path, hay, term);
    if (best === null) return null;
    total += best;
  }
  return total;
}

// ─── Ranking ───────────────────────────────────────────────────────

/**
 * Filter and rank `files` for `query`. `boost` lists paths that win ties,
 * most important first (open tabs, then recently opened).
 */
export function matchFiles(
  files: PreparedFile[],
  query: ParsedQuery,
  boost: readonly string[] = [],
): FileMatch[] {
  const boostRank = new Map<string, number>();
  boost.forEach((p, i) => {
    if (!boostRank.has(p)) boostRank.set(p, i);
  });
  const rankOf = (p: string) => boostRank.get(p) ?? Number.MAX_SAFE_INTEGER;

  const out: FileMatch[] = [];
  if (query.kind === "empty") {
    for (const f of files) out.push({ path: f.path, score: 0 });
  } else if (query.kind === "glob") {
    const re = globToRegExp(query.text, query.caseSensitive);
    const onName = !query.text.includes("/");
    for (const f of files) {
      if (re.test(onName ? f.path.slice(f.nameStart) : f.path)) {
        out.push({ path: f.path, score: 0 });
      }
    }
  } else {
    const terms = query.caseSensitive ? query.terms : query.terms.map((t) => t.toLowerCase());
    for (const f of files) {
      const score = scoreFile(f, terms, query.caseSensitive);
      if (score !== null) out.push({ path: f.path, score });
    }
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      rankOf(a.path) - rankOf(b.path) ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return out;
}

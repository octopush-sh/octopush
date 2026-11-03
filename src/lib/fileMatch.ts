/**
 * fileMatch — the ⌘P file finder's matcher. Pure; no React, no IPC.
 *
 * A query is one of:
 *   - a **glob** (contains `*`, `?`, `[`, `\` or a `{a,b}` group, and is at
 *     most `MAX_GLOB_LENGTH` long): without a `/` it matches the file name
 *     (`*.java`, `User*Test.kt`); with a `/` it matches the whole path
 *     (`src/**\/*.ts`, where `**\/` spans zero or more directories). Braces
 *     expand first (`*.{ts,tsx}`), and each alternative decides name or path
 *     on its own; `\` makes the next character literal (`\*.ts`);
 *   - **fuzzy** terms separated by spaces, all of which must match, scored
 *     fzf-style: bonuses for matching in the file name, at word / camel-case
 *     boundaries and in consecutive runs, penalties for gaps.
 *
 * Either may end in `:line` or `:line:col`, which is split off and opens the
 * file at that position (a bare `:42` is the empty query). A leading `./` and
 * the absolute workspace root are stripped so pasted paths match. Smart case:
 * an all-lowercase query ignores case, any capital makes it case-sensitive.
 * Query and paths are compared in NFC.
 *
 * Equal scores fall back to the caller's `boost` order (open tabs, recently
 * opened files), then to the shorter path, then alphabetical.
 *
 * `createMatchJob` ranks in small units (score + sort a chunk, or merge two
 * sorted chunks) so the finder can spread 20k paths over several frames and
 * no single pass blocks a keystroke for long.
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
  /** As listed; what a match reports and opens. */
  path: string;
  /** `path` in NFC, which is what is matched. */
  text: string;
  /** `foldCase(text)`: same length, so indices line up with `text`. */
  lower: string;
  /** Index in `text` where the file name starts (after the last `/`). */
  nameStart: number;
}

export interface FileMatch {
  path: string;
  score: number;
}

const ASCII = /^[\x00-\x7f]*$/;

/**
 * Lower-case `s` one UTF-16 unit at a time. A unit whose lower case is not a
 * single unit (`İ` → `i̇`) is kept as is, so the result has the same length
 * and every index still points at the same character of `s`.
 */
export function foldCase(s: string): string {
  if (ASCII.test(s)) return s.toLowerCase();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  return out;
}

export function prepareFiles(paths: string[]): PreparedFile[] {
  return paths.map((path) => {
    const text = ASCII.test(path) ? path : path.normalize("NFC");
    return { path, text, lower: foldCase(text), nameStart: text.lastIndexOf("/") + 1 };
  });
}

const GLOB_CHARS = /[*?[\\]/;
/** `:line`, `:line:col`, or the colons typed on the way there (`Foo.ts:`,
 *  `Foo.ts:42:`), which are dropped so the matches don't flicker away. */
const POSITION = /:(?:(\d+)(?::(\d*))?)?$/;
/** The largest `:line` / `:col` kept (int32 max); bigger numbers clamp to it. */
export const MAX_POSITION = 2 ** 31 - 1;
const position = (digits: string) => Math.min(MAX_POSITION, Math.max(1, Number(digits)));

/** The longest query treated as a glob; a longer one is fuzzy text. The
 *  automaton's worst case grows with the square of the pattern (see
 *  `compileGlob`), and 256 keeps a pasted `**\/**\/…` well under a frame. */
export const MAX_GLOB_LENGTH = 256;
/** The most alternatives `{a,b}` groups may expand to, and their total
 *  length; past either the query is fuzzy text. */
export const MAX_BRACE_ALTERNATIVES = 32;
const MAX_BRACE_TOTAL = 4 * MAX_GLOB_LENGTH;

/** The first `{…}` with a comma at its own level, skipping `\` escapes. */
function findBraces(glob: string): { open: number; close: number; commas: number[] } | null {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "\\") {
      i++;
      continue;
    }
    if (glob[i] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    for (let j = i; j < glob.length; j++) {
      const c = glob[j];
      if (c === "\\") j++;
      else if (c === "{") depth++;
      else if (c === "," && depth === 1) commas.push(j);
      else if (c === "}" && --depth === 0) {
        if (commas.length) return { open: i, close: j, commas };
        break; // `{a}` and `{}` are literal, as in bash.
      }
    }
  }
  return null;
}

/**
 * Expand `{a,b}` groups, bash-style and nested (`*.{ts,tsx}` → `*.ts`,
 * `*.tsx`). A `{` with no comma, or unclosed, is literal; escapes are kept
 * for `compileGlob`. `null` past `MAX_BRACE_ALTERNATIVES` or
 * `MAX_BRACE_TOTAL` characters, so `{a,b}{a,b}…` can't explode.
 */
export function expandBraces(glob: string): string[] | null {
  const out: string[] = [];
  let total = 0;
  // Depth-first; every group has two or more alternatives, so the work is
  // at most twice the output before the limits stop it.
  const pending = [glob];
  while (pending.length) {
    const g = pending.pop()!;
    const b = findBraces(g);
    if (!b) {
      total += g.length;
      if (out.push(g) > MAX_BRACE_ALTERNATIVES || total > MAX_BRACE_TOTAL) return null;
      continue;
    }
    const before = g.slice(0, b.open);
    const after = g.slice(b.close + 1);
    const cuts = [b.open, ...b.commas, b.close];
    // Pushed last-first so the alternatives come out in order.
    for (let k = cuts.length - 2; k >= 0; k--) pending.push(before + g.slice(cuts[k] + 1, cuts[k + 1]) + after);
  }
  return out;
}

/** Strip `./` and the workspace root so pasted paths match relative ones. */
export function normalizeQuery(raw: string, workspacePath = ""): string {
  let q = raw.trim();
  const root = workspacePath.normalize("NFC").replace(/\/+$/, "");
  if (root && (q === root || q.startsWith(root + "/"))) q = q.slice(root.length);
  q = q.replace(/^\/+/, "");
  while (q.startsWith("./")) q = q.slice(2);
  return q;
}

export function parseQuery(raw: string, workspacePath = ""): ParsedQuery {
  let text = normalizeQuery(raw.normalize("NFC"), workspacePath);
  let line: number | undefined;
  let col: number | undefined;
  const pos = POSITION.exec(text);
  if (pos) {
    if (pos[1] !== undefined) line = position(pos[1]);
    if (pos[2]) col = position(pos[2]);
    text = text.slice(0, pos.index);
  }
  const caseSensitive = text !== foldCase(text);
  // A bare `:42` names no file: it is the empty query, not "line 42 of
  // whichever file happens to rank first".
  if (!text) return { kind: "empty", text, terms: [], caseSensitive };
  const base = { text, caseSensitive, line, col };
  if (text.length <= MAX_GLOB_LENGTH) {
    const globs = expandBraces(text);
    if (globs && (globs.length > 1 || GLOB_CHARS.test(text))) return { ...base, kind: "glob", terms: [] };
  }
  return { ...base, kind: "fuzzy", terms: text.split(/\s+/).filter(Boolean) };
}

// ─── Globs ─────────────────────────────────────────────────────────

/** Glob states. All but SPLIT consume one character (a whole code point, so
 *  `?` takes `😀` in one go). */
const K_STAR = 0; // `*`: any run within a segment (loops on itself)
const K_GLOBSTAR = 1; // `**`: any run, `/` included (loops on itself)
const K_CHAR = 2; // a literal character
const K_ANY = 3; // `?`: any one character but `/`
const K_CLASS = 4; // `[...]`: one character (never `/`) in, or with `!`/`^` not in, the set
const K_SPLIT = 5; // before `**/`: skips it (no directory) or enters it; consumes nothing

interface GlobClass {
  negate: boolean;
  /** Code points. */
  chars: number[];
  /** Inclusive [lo, hi] code point pairs. */
  ranges: number[];
}

/** The code point at `i` (the next one when `i` holds a `\` that escapes
 *  something), and the index after it. */
function readLiteral(s: string, i: number): { cp: number; next: number } {
  if (s[i] === "\\" && i + 1 < s.length) i++;
  const cp = s.codePointAt(i)!;
  return { cp, next: i + (cp > 0xffff ? 2 : 1) };
}

function parseClass(glob: string, open: number): { cls: GlobClass; end: number } | null {
  let j = open + 1;
  const negate = glob[j] === "!" || glob[j] === "^";
  if (negate) j++;
  const chars: number[] = [];
  const ranges: number[] = [];
  // A `]` right after the opening (and `!`) is a member, as in POSIX; so is
  // an escaped one (`[\]]`).
  let first = true;
  while (j < glob.length) {
    if (glob[j] === "]" && !first) return { cls: { negate, chars, ranges }, end: j };
    first = false;
    const lo = readLiteral(glob, j);
    if (glob[lo.next] === "-" && lo.next + 1 < glob.length && glob[lo.next + 1] !== "]") {
      const hi = readLiteral(glob, lo.next + 1);
      // A backwards range (`[z-a]`) matches nothing, as in bash; it never throws.
      if (lo.cp <= hi.cp) ranges.push(lo.cp, hi.cp);
      j = hi.next;
    } else {
      chars.push(lo.cp);
      j = lo.next;
    }
  }
  return null; // Unclosed: the `[` is a literal.
}

const inClass = (cls: GlobClass, c: number) => {
  let hit = cls.chars.includes(c);
  for (let r = 0; !hit && r < cls.ranges.length; r += 2) hit = c >= cls.ranges[r] && c <= cls.ranges[r + 1];
  return hit !== cls.negate;
};

/** Bits per word of a state set; 30 leaves room to shift by up to 3. */
const WORD = 30;
const FULL = (1 << WORD) - 1;
const SLASH = 47;

/**
 * Compile a glob to a matcher that never throws: a bit-parallel NFA
 * (shift-and) with no backtracking, so no pattern can blow up
 * (`*a*a*a*a*b`). Each character costs O(pattern ÷ 30) for the step, plus
 * one such pass per link of the longest chain of empty moves `close`
 * follows (a run of stars and `**\/`s), so the worst case is
 * O(path × pattern² ÷ 30) — hence `MAX_GLOB_LENGTH`. Patterns under 30
 * states, nearly all of them, run on plain integers.
 *
 * `*` and `?` never cross `/`; `**` does, and `**\/` also matches no
 * directory at all. Consecutive stars collapse. `\` makes the next character
 * literal (a trailing `\` is itself). Braces are not handled here: expand
 * them with `expandBraces` first. Case-insensitive matching expects a
 * `foldCase`d subject. `from` matches `subject.slice(from)` without the copy.
 */
export function compileGlob(
  glob: string,
  caseSensitive: boolean,
): (subject: string, from?: number) => boolean {
  const pattern = caseSensitive ? glob : foldCase(glob);
  const kind: number[] = [];
  /** For K_CHAR the char code; for K_CLASS an index into `classes`. */
  const arg: number[] = [];
  const classes: GlobClass[] = [];
  /** The GLOBSTAR and `/` of a `**\/` are optional (zero directories). */
  const optional: boolean[] = [];
  const push = (k: number, a = 0, opt = false) => {
    kind.push(k);
    arg.push(a);
    optional.push(opt);
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      // A run of stars is one state: `*`, or `**` for two or more.
      let run = 1;
      while (pattern[i + 1] === "*") {
        run++;
        i++;
      }
      if (run >= 2 && pattern[i + 1] === "/") {
        i++;
        // `**\/` = SPLIT → (GLOBSTAR → `/`)?, i.e. "" or ".*/".
        push(K_SPLIT, 0, true);
        push(K_GLOBSTAR, 0, true);
        push(K_CHAR, SLASH, true);
      } else {
        push(run >= 2 ? K_GLOBSTAR : K_STAR);
      }
    } else if (c === "?") {
      push(K_ANY);
    } else {
      const parsed = c === "[" ? parseClass(pattern, i) : null;
      if (parsed) {
        push(K_CLASS, classes.push(parsed.cls) - 1);
        i = parsed.end;
      } else {
        // A literal: an unclosed `[`, an escaped character, or any other.
        const lit = readLiteral(pattern, i);
        push(K_CHAR, lit.cp);
        i = lit.next - 1;
      }
    }
  }

  // State `i` is bit `i % WORD` of word `i / WORD`; state `m` accepts.
  const m = kind.length;
  const W = Math.floor(m / WORD) + 1;
  const bits = (test: (i: number) => boolean) => {
    const set = new Int32Array(W);
    for (let i = 0; i < m; i++) if (test(i)) set[(i / WORD) | 0] |= 1 << i % WORD;
    return set;
  };
  /** States that stay put on a character other than `/`, and on `/`. */
  const loopAny = bits((i) => kind[i] === K_STAR || kind[i] === K_GLOBSTAR);
  const loopSlash = bits((i) => kind[i] === K_GLOBSTAR);
  const split = bits((i) => kind[i] === K_SPLIT);

  /** States that consume code point `c` and move on, cached per code point. */
  const asciiCache: (Int32Array | undefined)[] = new Array(128);
  const cache = new Map<number, Int32Array>();
  const advance = (c: number) => {
    let set = c < 128 ? asciiCache[c] : cache.get(c);
    if (!set) {
      set = bits((i) => {
        const k = kind[i];
        if (k === K_CHAR) return arg[i] === c;
        if (c === SLASH) return false;
        if (k === K_ANY) return true;
        return k === K_CLASS && inClass(classes[arg[i]], c);
      });
      if (c < 128) asciiCache[c] = set;
      else cache.set(c, set);
    }
    return set;
  };

  /** Follow the empty moves: a loop state may be left, a SPLIT goes either
   *  way. Moves only go forward, so a pass that adds nothing is the end. */
  const close = (set: Int32Array) => {
    for (let changed = true; changed; ) {
      changed = false;
      let carry1 = 0;
      let carry3 = 0;
      for (let w = 0; w < W; w++) {
        const v = set[w];
        const sp = v & split[w];
        const one = (v & loopAny[w]) | sp;
        const nv = v | ((one << 1) & FULL) | carry1 | ((sp << 3) & FULL) | carry3;
        carry1 = one >>> (WORD - 1);
        carry3 = sp >>> (WORD - 3);
        if (nv !== v) {
          set[w] = nv;
          changed = true;
        }
      }
    }
  };

  const start = new Int32Array(W);
  start[0] = 1;
  close(start);

  // Cheap rejections before the automaton: the literal head and tail every
  // match must have (`*.java` → ends in ".java"), and the fewest characters.
  let head = 0;
  while (head < m && kind[head] === K_CHAR) head++;
  let tail = 0;
  while (tail < m - head && kind[m - 1 - tail] === K_CHAR && !optional[m - 1 - tail]) tail++;
  const headText = String.fromCodePoint(...arg.slice(0, head));
  const tailText = String.fromCodePoint(...arg.slice(m - tail));
  // In UTF-16 units: every consuming state takes at least one.
  let minLength = Math.max(headText.length, tailText.length);
  let consuming = 0;
  for (let i = 0; i < m; i++) if (kind[i] >= K_CHAR && kind[i] <= K_CLASS && !optional[i]) consuming++;
  minLength = Math.max(minLength, consuming);
  const fits = (subject: string, from: number) =>
    subject.length - from >= minLength && subject.startsWith(headText, from) && subject.endsWith(tailText);

  /** The code point at `p` of `subject`; a pair of surrogates is one. */
  const codeAt = (subject: string, p: number) => {
    const c = subject.charCodeAt(p);
    return c >= 0xd800 && c <= 0xdbff ? subject.codePointAt(p)! : c;
  };

  if (W === 1) {
    // Under 30 states (nearly every glob): the same, on plain integers.
    const loopA = loopAny[0];
    const loopS = loopSlash[0];
    const sp = split[0];
    const close1 = (set: number) => {
      for (;;) {
        const next = set | ((set & (loopA | sp)) << 1) | ((set & sp) << 3);
        if (next === set) return set;
        set = next;
      }
    };
    const start1 = start[0];
    const accept = 1 << m;
    const ascii1 = new Int32Array(128).fill(-1);
    return (subject, from = 0) => {
      if (!fits(subject, from)) return false;
      let set = start1;
      for (let p = from; p < subject.length; p++) {
        const c = codeAt(subject, p);
        if (c > 0xffff) p++;
        let adv = c < 128 ? ascii1[c] : -1;
        if (adv < 0) {
          adv = advance(c)[0];
          if (c < 128) ascii1[c] = adv;
        }
        set = (set & (c === SLASH ? loopS : loopA)) | ((set & adv) << 1);
        if (set === 0) return false;
        set = close1(set);
      }
      return (set & accept) !== 0;
    };
  }
  const acceptWord = (m / WORD) | 0;
  const acceptBit = 1 << m % WORD;
  const bufA = new Int32Array(W);
  const bufB = new Int32Array(W);

  return (subject, from = 0) => {
    if (!fits(subject, from)) return false;
    let cur = bufA;
    let nxt = bufB;
    cur.set(start);
    for (let p = from; p < subject.length; p++) {
      const c = codeAt(subject, p);
      if (c > 0xffff) p++;
      const adv = advance(c);
      const loop = c === SLASH ? loopSlash : loopAny;
      let carry = 0;
      let alive = 0;
      for (let w = 0; w < W; w++) {
        const a = cur[w] & adv[w];
        const v = (cur[w] & loop[w]) | ((a << 1) & FULL) | carry;
        carry = a >>> (WORD - 1);
        nxt[w] = v;
        alive |= v;
      }
      if (!alive) return false;
      close(nxt);
      const t = cur;
      cur = nxt;
      nxt = t;
    }
    return (cur[acceptWord] & acceptBit) !== 0;
  };
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
/** A term that is the whole file name, or its stem (`user` → `User.java`). */
const BONUS_EXACT_NAME = 32;

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
  const hay = caseSensitive ? file.text : file.lower;
  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    if (!term.includes("/")) {
      const inName = scoreTerm(file.text, hay, term, file.nameStart);
      if (inName !== null) {
        best = inName + BONUS_FILE_NAME;
        // The name itself, or the name up to a dot (`User.java`, `User.test.ts`).
        const after = file.nameStart + term.length;
        if (hay.startsWith(term, file.nameStart) && (after === hay.length || hay[after] === ".")) {
          best += BONUS_EXACT_NAME;
        }
      }
    }
    if (best === null) best = scoreTerm(file.text, hay, term);
    if (best === null) return null;
    total += best;
  }
  return total;
}

// ─── Ranking ───────────────────────────────────────────────────────

/** Files scored and sorted per unit of work; one unit is the most a
 *  `MatchJob.step` can overrun its deadline by. */
export const MATCH_CHUNK = 2048;

/** A ranking split into small units so the UI can spread it over frames. */
export interface MatchJob {
  /** Work until `performance.now()` passes `deadline` (at least one unit);
   *  `true` once the ranking is complete. */
  step: (deadline: number) => boolean;
  /** The ranking; complete only after `step` returned `true`. */
  result: () => FileMatch[];
}

interface Ranked extends FileMatch {
  /** Position in `boost`; MAX_SAFE_INTEGER when not boosted. */
  rank: number;
}

const compareRanked = (a: Ranked, b: Ranked) =>
  b.score - a.score ||
  a.rank - b.rank ||
  a.path.length - b.path.length ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function mergeRanked(a: Ranked[], b: Ranked[]): Ranked[] {
  const out: Ranked[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compareRanked(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * Rank `files` for `query` in units: score and sort `MATCH_CHUNK` files at a
 * time, then merge the sorted chunks pairwise. `boost` lists paths that win
 * ties, most important first (open tabs, then recently opened).
 */
export function createMatchJob(
  files: PreparedFile[],
  query: ParsedQuery,
  boost: readonly string[] = [],
): MatchJob {
  const boostRank = new Map<string, number>();
  boost.forEach((p, i) => {
    if (!boostRank.has(p)) boostRank.set(p, i);
  });
  const rankOf = (p: string) => boostRank.get(p) ?? Number.MAX_SAFE_INTEGER;

  let score: (f: PreparedFile) => number | null;
  if (query.kind === "empty") {
    score = () => 0;
  } else if (query.kind === "glob") {
    // One matcher per brace alternative; each picks name or path on its own
    // (`{src/**/*.ts,*.md}`).
    const globs = (expandBraces(query.text) ?? [query.text]).map((g) => ({
      matches: compileGlob(g, query.caseSensitive),
      onName: !g.includes("/"),
    }));
    score = (f) => {
      const subject = query.caseSensitive ? f.text : f.lower;
      return globs.some((g) => g.matches(subject, g.onName ? f.nameStart : 0)) ? 0 : null;
    };
  } else {
    const terms = query.caseSensitive ? query.terms : query.terms.map(foldCase);
    score = (f) => scoreFile(f, terms, query.caseSensitive);
  }

  let next = 0;
  // Sorted runs waiting to be merged, as a queue so merges stay balanced.
  const runs: Ranked[][] = [];
  let done = false;

  const unit = () => {
    if (next < files.length) {
      const end = Math.min(files.length, next + MATCH_CHUNK);
      const run: Ranked[] = [];
      for (; next < end; next++) {
        const f = files[next];
        const s = score(f);
        if (s !== null) run.push({ path: f.path, score: s, rank: rankOf(f.path) });
      }
      run.sort(compareRanked);
      runs.push(run);
    } else if (runs.length > 1) {
      const a = runs.shift()!;
      const b = runs.shift()!;
      runs.push(mergeRanked(a, b));
    }
    done = next >= files.length && runs.length <= 1;
  };

  return {
    step: (deadline) => {
      if (done) return true;
      do unit();
      while (!done && performance.now() < deadline);
      return done;
    },
    result: () => runs[0] ?? [],
  };
}

/** Filter and rank `files` for `query` in one go (see `createMatchJob`). */
export function matchFiles(
  files: PreparedFile[],
  query: ParsedQuery,
  boost: readonly string[] = [],
): FileMatch[] {
  const job = createMatchJob(files, query, boost);
  job.step(Infinity);
  return job.result();
}

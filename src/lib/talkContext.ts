/**
 * Pure helpers for Talk's context mentions — the `@` tokens beyond a whole
 * file (#962):
 *
 * - `@path#L10-40` — a line range of a file (`#L10` for one line);
 * - `@folder/`     — a listing of a folder (paths and sizes, not contents);
 * - `@session:<slug>` — the last lines a Run session printed (`@session`
 *   alone when the workspace has exactly one session);
 * - `@diff` / `@diff:<path>` — the workspace's uncommitted diff (staged and
 *   not staged), or one (existing) file's.
 *
 * Every expansion shares the 64k cap whole-file mentions already use. The
 * composer shows each resolved token as a removable chip with its token
 * estimate; the chip mirrors the text, so removing it removes the token.
 */

import { rankFiles } from "./mentions";

/** The byte/char cap every expansion shares (the `@file` read cap). */
export const CONTEXT_CAP = 64_000;
/** How many of a session's last lines `@session` attaches. */
export const SESSION_TAIL_LINES = 200;
/** Most entries a folder listing names before it says how many it left out. */
export const FOLDER_MAX_ENTRIES = 500;

export interface SessionRef {
  id: string;
  label: string;
  /** The token after `@session:` — the label, kebab-cased, unique. */
  slug: string;
}

export type ContextRef =
  | { kind: "file"; token: string; path: string; range: { start: number; end: number } | null }
  | { kind: "folder"; token: string; path: string }
  | { kind: "session"; token: string; session: SessionRef }
  | { kind: "diff"; token: string; path: string | null };

export interface ContextCatalog {
  files: Set<string>;
  dirs: Set<string>;
  sessions: SessionRef[];
}

/** Every ancestor folder of the catalog's files (no trailing slash). */
export function dirsOf(files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf("/");
    while (i > 0) {
      const d = f.slice(0, i);
      if (out.has(d)) break;
      out.add(d);
      i = d.lastIndexOf("/");
    }
  }
  return out;
}

/** Give each session a unique, typeable slug from its label. */
export function sessionRefs(terminals: { id: string; label: string }[]): SessionRef[] {
  const seen = new Map<string, number>();
  return terminals.map((t) => {
    const base =
      t.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: t.id, label: t.label, slug: n === 1 ? base : `${base}-${n}` };
  });
}

/** `path#L10-40` → the path and range; `#L10` is one line; a reversed range
 *  is put in order. Null when the token carries no range. */
export function parseLineRange(
  token: string,
): { path: string; start: number; end: number } | null {
  const m = /^(.+)#L(\d+)(?:-L?(\d+))?$/.exec(token);
  if (!m) return null;
  const a = Number(m[2]);
  const b = m[3] != null ? Number(m[3]) : a;
  if (a < 1 || b < 1) return null;
  return { path: m[1], start: Math.min(a, b), end: Math.max(a, b) };
}

/** The `@path#L5-10` token for a range (`#L5` when it is one line). */
export function rangeToken(path: string, start: number, end: number): string {
  return start === end ? `${path}#L${start}` : `${path}#L${start}-${end}`;
}

const TRAILING_PUNCT = /[.,;:!?)\]}'"`]+$/;

function resolveToken(token: string, cat: ContextCatalog): ContextRef | null {
  if (cat.files.has(token)) return { kind: "file", token, path: token, range: null };
  const range = parseLineRange(token);
  if (range && cat.files.has(range.path)) {
    return { kind: "file", token, path: range.path, range: { start: range.start, end: range.end } };
  }
  if (token.endsWith("/") && cat.dirs.has(token.slice(0, -1))) {
    return { kind: "folder", token, path: token.slice(0, -1) };
  }
  if (token === "diff") return { kind: "diff", token, path: null };
  if (token.startsWith("diff:") && cat.files.has(token.slice(5))) {
    return { kind: "diff", token, path: token.slice(5) };
  }
  if (token === "session" && cat.sessions.length === 1) {
    return { kind: "session", token, session: cat.sessions[0] };
  }
  if (token.startsWith("session:")) {
    const s = cat.sessions.find((x) => x.slug === token.slice(8));
    if (s) return { kind: "session", token, session: s };
  }
  return null;
}

/** Every context token of a draft, in order, once each. Stray `@handles` and
 *  tokens naming nothing the workspace has are left as prose. */
export function extractContextRefs(text: string, cat: ContextCatalog): ContextRef[] {
  const out: ContextRef[] = [];
  const re = /(?:^|[\s([{"'`])@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const ref = resolveToken(raw, cat) ?? resolveToken(raw.replace(TRAILING_PUNCT, ""), cat);
    if (ref && !out.some((r) => r.token === ref.token)) out.push(ref);
  }
  return out;
}

/** Remove the first `@token` from a draft (and one space after it). The token
 *  only matches where the extractor would have ended it — trailing
 *  punctuation, then whitespace or the end — so `@diff` never matches the
 *  start of `@diff:src/a.ts`. */
export function removeContextToken(text: string, token: string): string {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s([{"'\`])@${esc}(?=[.,;:!?)\\]}'"\`]*(?:$|\\s)) ?`);
  return text.replace(re, "$1");
}

/** The popover's rows for the `@query` being typed: `diff` and sessions when
 *  the query reads as one (or is empty), folders and files otherwise. */
export function contextMentionItems(
  query: string,
  files: string[],
  dirs: Set<string>,
  sessions: SessionRef[],
  limit = 8,
): string[] {
  const q = query.toLowerCase();
  if (q.startsWith("session:")) {
    const s = q.slice(8);
    return sessions.filter((x) => x.slug.includes(s)).slice(0, limit).map((x) => `session:${x.slug}`);
  }
  if (q.startsWith("diff:")) {
    return rankFiles(files, query.slice(5), limit).map((p) => `diff:${p}`);
  }
  const special: string[] = [];
  if ("diff".startsWith(q)) special.push("diff");
  if (q && "session".startsWith(q)) special.push(...sessions.map((x) => `session:${x.slug}`));
  else if (!q && sessions[0]) special.push(`session:${sessions[0].slug}`);
  const paths = rankFiles([...[...dirs].map((d) => `${d}/`), ...files], query, limit);
  return [...special, ...paths].slice(0, limit);
}

/** Lines `start..end` (1-based, clamped to the file) of `content`. */
export function sliceLines(
  content: string,
  start: number,
  end: number,
): { text: string; start: number; end: number; total: number } {
  const lines = content.split("\n");
  const total = lines.length;
  const s = Math.min(Math.max(1, start), total);
  const e = Math.min(Math.max(s, end), total);
  return { text: lines.slice(s - 1, e).join("\n"), start: s, end: e, total };
}

/** The last `n` non-trailing-blank lines of a terminal buffer. */
export function tailLines(lines: string[], n: number): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(Math.max(0, end - n), end);
}

/** A terminal buffer's rows (untrimmed, as `translateToString(false)` gives
 *  them) joined into logical lines: a soft-wrapped row continues the row
 *  above it, and only each logical line's end is trimmed, so a wrap that
 *  falls on a space keeps it. */
export function joinWrappedRows(rows: { text: string; wrapped: boolean }[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.map((l) => l.trimEnd());
}

/** The newest lines that fit in CONTEXT_CAP, oldest first. When it had to
 *  leave older output out, `cut` is true and `lines` counts what was kept. */
export function capTail(lines: string[]): { text: string; lines: number; cut: boolean } {
  const kept: string[] = [];
  let len = 0;
  let cut = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (len + add > CONTEXT_CAP) {
      // One line longer than the whole cap: keep its end.
      if (kept.length === 0) kept.push(lines[i].slice(-CONTEXT_CAP));
      cut = true;
      break;
    }
    kept.unshift(lines[i]);
    len += add;
  }
  return { text: kept.join("\n"), lines: kept.length, cut };
}

/** The uncommitted diff: what is staged, then what isn't staged yet, each
 *  under its own label when there is any; "" when neither has changes. */
export function joinDiffs(staged: string, unstaged: string): string {
  const parts: string[] = [];
  if (staged.trim()) parts.push(`# Staged\n${staged.trimEnd()}`);
  if (unstaged.trim()) parts.push(`# Not staged\n${unstaged.trimEnd()}`);
  return parts.join("\n\n");
}

/** Strip ANSI escape sequences (CSI, OSC, single-char escapes). */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/** One file's section of a unified diff, or "" when it isn't in it. */
export function diffForFile(diff: string, path: string): string {
  const parts = diff.split(/^(?=diff --git )/m);
  return (
    parts.find((p) => {
      const head = p.slice(0, p.indexOf("\n") === -1 ? p.length : p.indexOf("\n"));
      return head.endsWith(` b/${path}`) || head.includes(` a/${path} `);
    }) ?? ""
  ).trimEnd();
}

/** "812 B" / "14 KB" / "2.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A folder listing: each file relative to the folder with its size, capped
 *  by entries and by CONTEXT_CAP, and saying what it left out. */
export function formatFolderListing(
  folder: string,
  entries: { path: string; size: number | null }[],
): string {
  const lines: string[] = [];
  let len = 0;
  let shown = 0;
  for (const e of entries) {
    if (shown >= FOLDER_MAX_ENTRIES) break;
    const rel = e.path.startsWith(`${folder}/`) ? e.path.slice(folder.length + 1) : e.path;
    const line = `${rel}  ${e.size == null ? "?" : formatBytes(e.size)}`;
    if (len + line.length + 1 > CONTEXT_CAP) break;
    lines.push(line);
    len += line.length + 1;
    shown++;
  }
  if (shown < entries.length) lines.push(`… ${entries.length - shown} more not listed`);
  return lines.join("\n");
}

/** Cap a text block at CONTEXT_CAP, saying so when it cut. */
export function capText(s: string): string {
  return s.length <= CONTEXT_CAP ? s : `${s.slice(0, CONTEXT_CAP)}\n… (cut at 64k characters)`;
}

/** A fenced block appended to the outgoing message, headed by a plain line. */
export function fenced(heading: string, body: string, lang = ""): string {
  return `\n\n${heading}\n\`\`\`${lang}\n${body}\n\`\`\``;
}

/** The chip's short label: the basename (with its range), the folder, the
 *  session's label, or the diff's file. */
export function chipLabel(ref: ContextRef): string {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  switch (ref.kind) {
    case "file":
      return ref.range ? rangeToken(base(ref.path), ref.range.start, ref.range.end) : base(ref.path);
    case "folder":
      return `${base(ref.path)}/`;
    case "session":
      return ref.session.label;
    case "diff":
      return ref.path ? `diff · ${base(ref.path)}` : "diff";
  }
}

/** The same chars/4 heuristic the composer's estimate uses. */
export function blockTokens(block: string): number {
  return block ? Math.ceil(block.length / 4) : 0;
}

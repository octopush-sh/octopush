/**
 * Review comments (#956): "Ask for a change" on a hunk or on lines of it,
 * collected in the Review Companion's tray and sent to the agent as one
 * message. A comment is anchored to its hunk's `hunkFingerprint`, so when the
 * hunk changes (or leaves the diff) the comment reads as outdated, not lost.
 */
import { hunkFingerprint, type DiffFile, type DiffHunk, type DiffRow } from "./diffParser";
import type { RunStage } from "./ipc";

export interface ReviewComment {
  id: string;
  filePath: string;
  /** `hunkFingerprint` of the hunk the comment was left on. */
  fingerprint: string;
  /** First and last line commented on, all from one side of the diff: the
   *  new side, or the old side (`removed`) when every picked row is a
   *  deletion. */
  startLine: number;
  endLine: number;
  /** The lines are old-side numbers: the comment is on removed rows only. */
  removed?: boolean;
  /** The commented rows as the diff showed them, signed (`+`, `-`, ` `):
   *  at most `MAX_QUOTE_LINES`, each cut to `MAX_QUOTE_LINE_CHARS`. */
  quote: string[];
  /** Rows of the comment left out of `quote` by the cap. */
  quoteCut?: number;
  note: string;
}

/** A comment's quote is capped: a whole-hunk comment on a large new file
 *  would otherwise put the whole file into a paid turn. The place still
 *  names the full range, and the message says how many rows were left out. */
export const MAX_QUOTE_LINES = 20;
export const MAX_QUOTE_LINE_CHARS = 240;

const cutLine = (l: string) => (l.length > MAX_QUOTE_LINE_CHARS ? `${l.slice(0, MAX_QUOTE_LINE_CHARS - 1)}…` : l);

/** Rows `from..to` (inclusive, any order) of one hunk, as a draft comment's
 *  anchor. The whole hunk when no rows are given. */
export function commentAnchor(
  filePath: string,
  hunk: DiffHunk,
  rows?: { from: number; to: number },
): Omit<ReviewComment, "id" | "note"> {
  const lo = rows ? Math.max(0, Math.min(rows.from, rows.to)) : 0;
  const hi = rows ? Math.min(hunk.rows.length - 1, Math.max(rows.from, rows.to)) : hunk.rows.length - 1;
  const picked = hunk.rows.slice(lo, hi + 1);
  // One side per range: an old-side number next to a new-side one names two
  // different files' lines. New-side lines whenever a picked row has one;
  // old-side only when every picked row was removed.
  const news = picked.map((r) => r.newLine).filter((n): n is number => n !== null);
  const olds = picked.map((r) => r.oldLine).filter((n): n is number => n !== null);
  const removed = news.length === 0 && olds.length > 0;
  const lines = removed ? olds : news;
  const cut = picked.length - MAX_QUOTE_LINES;
  return {
    filePath,
    fingerprint: hunkFingerprint(hunk),
    startLine: lines.length ? Math.min(...lines) : 1,
    endLine: lines.length ? Math.max(...lines) : 1,
    ...(removed && { removed }),
    quote: picked.slice(0, MAX_QUOTE_LINES).map((r) => cutLine(`${SIGN[r.kind]}${r.text}`)),
    ...(cut > 0 && { quoteCut: cut }),
  };
}

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "-", context: " " };

/** `src/a.ts:12` or `src/a.ts:12–18`; `src/a.ts:12 (removed)` when the lines
 *  are old-side numbers. */
export function commentLocation(c: Pick<ReviewComment, "filePath" | "startLine" | "endLine" | "removed">): string {
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}–${c.endLine}`;
  return `${c.filePath}:${range}${c.removed ? " (removed)" : ""}`;
}

/** What a comment's quote left out, as the message and the tray say it. */
export function quoteCutNote(n: number): string {
  return `… ${n} more line${n === 1 ? "" : "s"} not quoted`;
}

/** The open "Ask for a change" field: where it sits in the diff on screen,
 *  the anchor taken when the place was picked, and the note typed so far. */
export interface CommentDraft {
  filePath: string;
  hunkIdx: number;
  rows?: { from: number; to: number };
  anchor: Omit<ReviewComment, "id" | "note">;
  note: string;
  /** The hunk changed under the draft: it keeps the anchor it was opened
   *  with, and is added as an outdated comment. */
  stale: boolean;
}

/** The rows a draft is on after ⌥↑ / ⌥↓ (`extend` = with ⇧), in a hunk of
 *  `count` rows: the keyboard's click and shift-click on a line number. A
 *  move picks the one row past the range's edge in that direction; an
 *  extend moves the range's free end (`to`) and keeps where it began. A
 *  whole-hunk draft starts at its first row going down, its last going up.
 *  Pure. */
export function stepPick(rows: { from: number; to: number } | undefined, count: number, dir: -1 | 1, extend: boolean): { from: number; to: number } | undefined {
  if (count <= 0) return rows;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  if (!rows) {
    const at = dir > 0 ? 0 : count - 1;
    return { from: at, to: at };
  }
  if (extend) return { from: rows.from, to: clamp(rows.to + dir) };
  const at = clamp(dir > 0 ? Math.max(rows.from, rows.to) + 1 : Math.min(rows.from, rows.to) - 1);
  return { from: at, to: at };
}

/** Where a draft sits after the diff was fetched again. The same draft when
 *  its hunk is still there (followed to its new index); a stale one, under
 *  the nearest hunk of its file, when the hunk changed, so what was typed
 *  stays on screen; `null` when the file left the diff. */
export function reanchorDraft(d: CommentDraft, files: DiffFile[]): CommentDraft | null {
  const hunks = files.find((f) => f.filePath === d.filePath)?.hunks ?? [];
  const is = (h: DiffHunk | undefined) => !!h && hunkFingerprint(h) === d.anchor.fingerprint;
  if (is(hunks[d.hunkIdx])) return d.stale ? { ...d, stale: false } : d;
  const moved = hunks.findIndex(is);
  if (moved >= 0) return { ...d, hunkIdx: moved, stale: false };
  if (hunks.length === 0) return null;
  const hunkIdx = Math.min(d.hunkIdx, hunks.length - 1);
  return d.stale && d.hunkIdx === hunkIdx ? d : { ...d, hunkIdx, rows: undefined, stale: true };
}

/** `file\nfingerprint` of every hunk in a diff: what the outdated check reads. */
export function liveHunkKeys(files: DiffFile[]): Set<string> {
  return new Set(files.flatMap((f) => f.hunks.map((h) => `${f.filePath}\n${hunkFingerprint(h)}`)));
}

/** True when the hunk the comment was left on is no longer in the diff (it
 *  changed, was accepted or rejected). Unknown (`live` null) is not outdated. */
export function isOutdated(c: ReviewComment, live: Set<string> | null): boolean {
  return !!live && !live.has(`${c.filePath}\n${c.fingerprint}`);
}

/** The one message the tray sends: each comment a quoted block with its
 *  location, then the note. */
export function commentsMessage(comments: ReviewComment[], live: Set<string> | null): string {
  const n = comments.length;
  const head = `I reviewed the diff and left ${n} comment${n === 1 ? "" : "s"}. Please make these changes:`;
  const blocks = comments.map((c) => {
    const where = `\`${commentLocation(c)}\`${isOutdated(c, live) ? " (this hunk has changed since)" : ""}`;
    const quote = [...c.quote, ...(c.quoteCut ? [quoteCutNote(c.quoteCut)] : [])].map((l) => `> ${l}`).join("\n");
    return `${where}\n${quote}\n\n${c.note.trim()}`;
  });
  return [head, ...blocks].join("\n\n");
}

/** The gate a stage parks at when the director can send it back: a gated
 *  loop with a target stage, past the budget park (a stage that never started
 *  has nothing to send back). `atCap` once the loop used all its iterations. */
export function sendBackGate(
  blocked: RunStage | null,
  stages: readonly RunStage[],
): { stage: RunStage; target: RunStage; iteration: number; max: number; atCap: boolean } | null {
  if (!blocked || blocked.status !== "awaiting_checkpoint") return null;
  if (blocked.startedAt === null && blocked.artifact === null) return null;
  if (blocked.loopMode !== "gated" || blocked.loopTargetPosition === null) return null;
  const target = stages.find((s) => s.position === blocked.loopTargetPosition);
  if (!target) return null;
  const iteration = blocked.loopIterations;
  const max = blocked.loopMaxIterations;
  return { stage: blocked, target, iteration, max, atCap: iteration >= max };
}

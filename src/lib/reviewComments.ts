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
  /** First and last line commented on (new side, old side for a deletion). */
  startLine: number;
  endLine: number;
  /** The commented rows as the diff showed them, signed (`+`, `-`, ` `). */
  quote: string[];
  note: string;
}

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
  const lines = picked.map(lineOf).filter((n): n is number => n !== null);
  return {
    filePath,
    fingerprint: hunkFingerprint(hunk),
    startLine: lines.length ? Math.min(...lines) : 1,
    endLine: lines.length ? Math.max(...lines) : 1,
    quote: picked.map((r) => `${SIGN[r.kind]}${r.text}`),
  };
}

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "-", context: " " };
const lineOf = (r: DiffRow) => r.newLine ?? r.oldLine;

/** `src/a.ts:12` or `src/a.ts:12–18`. */
export function commentLocation(c: Pick<ReviewComment, "filePath" | "startLine" | "endLine">): string {
  return c.startLine === c.endLine ? `${c.filePath}:${c.startLine}` : `${c.filePath}:${c.startLine}–${c.endLine}`;
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
    const quote = c.quote.map((l) => `> ${l}`).join("\n");
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

// The Run Companion's Changes section, as data: what the workspace's
// uncommitted files are and how many lines each gained and lost. Pure (no
// stores, no React) so the wording and the counting are unit-tested.

import type { FileChange } from "./types";
import type { DiffStat } from "./modeMeta";
import { isDiffTruncated } from "./reviewSource";

/** The one-letter status of a changed file — the letters Review's Changes
 *  list shows, so a file reads the same on both sides of the handoff. */
export const STATUS_LETTER: Record<FileChange["status"], string> = {
  new: "N",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unknown: "?",
  conflicted: "!",
};

/** The status as a word, for the letter's tooltip. */
export const STATUS_WORD: Record<FileChange["status"], string> = {
  new: "New file",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  unknown: "Changed",
  conflicted: "Conflicted",
};

/** Lines added and removed per file of a working diff, and whether that is
 *  the whole diff. */
export interface ChangeStats {
  byFile: Record<string, DiffStat>;
  /** False when the backend's 1 MiB cap cut the diff: files past the cut
   *  have no entry, so no total can be given. */
  complete: boolean;
}

export const NO_CHANGE_STATS: ChangeStats = { byFile: {}, complete: true };

/**
 * Added/removed line counts per file of a unified diff, keyed by the path
 * on the `b/` side. Counts only lines inside a hunk, like `diffStat`
 * (`modeMeta.ts`), so a `+++`/`---` header is never taken for content. A
 * file with no hunk (binary, mode-only) has no entry; neither does the file
 * a truncated diff was cut in, whose count would be partial.
 */
export function changeStats(diff: string): ChangeStats {
  const byFile: Record<string, DiffStat> = {};
  let cur: DiffStat | null = null;
  let last: string | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = null;
      last = m ? m[2] : null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      if (!cur && last != null) {
        cur = { added: 0, removed: 0 };
        byFile[last] = cur;
      }
      continue;
    }
    if (!inHunk || !cur) continue;
    if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.removed++;
  }
  const complete = !isDiffTruncated(diff);
  if (!complete && last != null) delete byFile[last];
  return { byFile, complete };
}

/** Same counts, so a poll that changed nothing keeps the state it had. */
export function sameChangeStats(a: ChangeStats, b: ChangeStats): boolean {
  if (a.complete !== b.complete) return false;
  const ka = Object.keys(a.byFile);
  if (ka.length !== Object.keys(b.byFile).length) return false;
  return ka.every((k) => {
    const x = a.byFile[k];
    const y = b.byFile[k];
    return !!y && x.added === y.added && x.removed === y.removed;
  });
}

/** `+84 −12`, or just the side that has lines. */
export function statLabel(stat: DiffStat): string {
  return [stat.added > 0 ? `+${stat.added}` : "", stat.removed > 0 ? `−${stat.removed}` : ""].filter(Boolean).join(" ");
}

/**
 * The Changes eyebrow's meta: `3 files · +84 −12`. The line total is the
 * sum over the listed files and is left out when it can't be whole (a
 * truncated diff) or is nothing (staged-only or binary changes: the working
 * diff holds no lines for them). Null for a clean tree.
 */
export function changesMeta(files: readonly FileChange[], stats: ChangeStats): string | null {
  if (files.length === 0) return null;
  const count = files.length === 1 ? "1 file" : `${files.length} files`;
  if (!stats.complete) return count;
  const total: DiffStat = { added: 0, removed: 0 };
  for (const f of files) {
    const s = stats.byFile[f.path];
    if (s) {
      total.added += s.added;
      total.removed += s.removed;
    }
  }
  const label = statLabel(total);
  return label ? `${count} · ${label}` : count;
}

/** How many rows the list shows before `+N more`. */
export const MAX_CHANGE_ROWS = 8;

/** How many trailing characters of a path stay pinned when it is elided: the
 *  file name with its slash, so the name survives whole. Kept between 8 and
 *  20 characters: a pinned tail never shrinks, and 20 (plus the ellipsis)
 *  still fits beside two four-digit counts in the Companion at its
 *  narrowest, so a longer name keeps its end, the part with the extension. */
export function pathTail(path: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return Math.max(8, Math.min(20, name.length + 1));
}

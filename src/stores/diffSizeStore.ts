/**
 * diffSizeStore — how much code each Mission Control card holds for review.
 *
 * Computed ONCE per run per settled state (`<runId>:<status>:<statusSince>`):
 * a card that pauses, resumes and pauses again is measured again (each pause
 * has its own `statusSince`), and a card that later completes is measured
 * again, but re-renders, re-opens of the room and stage events never re-diff.
 * `null` means "nothing to show" (the workspace or its worktree is gone, or
 * the diff failed) — never a made-up zero.
 *
 * Measurements are throttled: at most [`MAX_CONCURRENT_MEASURES`] diffs run at
 * once, the rest wait in a queue, so opening a room of twenty settled crews
 * never starts twenty diffs together. Sizes of runs no longer on the board are
 * evicted with [`prune`].
 */
import { create } from "zustand";
import { ipc, type DiffSize } from "../lib/ipc";

/** At most this many workspace diffs run at once. */
export const MAX_CONCURRENT_MEASURES = 2;

interface DiffSizeState {
  /** Keyed by `diffSizeKey(runId, status, since)`; absent = not measured yet. */
  byKey: Record<string, DiffSize | null>;
  /** Measure the workspace for this run state, once (queued past the cap). */
  ensure: (runId: string, status: string, since: number | undefined, workspaceId: string) => void;
  /** Drop every size (and queued measure) of a run not in `runIds`. */
  prune: (runIds: Iterable<string>) => void;
}

/** One run state: a re-pause (a new `statusSince`) is a new key. */
export const diffSizeKey = (runId: string, status: string, since?: number) =>
  `${runId}:${status}:${since ?? ""}`;

const runOfKey = (key: string) => key.slice(0, key.indexOf(":"));

const inflight = new Set<string>();
let running = 0;
const queue: { key: string; workspaceId: string }[] = [];

export const useDiffSizeStore = create<DiffSizeState>((set, get) => {
  const pump = () => {
    while (running < MAX_CONCURRENT_MEASURES && queue.length > 0) {
      const { key, workspaceId } = queue.shift()!;
      running += 1;
      Promise.resolve()
        .then(() => ipc.workspaceDiffSize(workspaceId))
        .catch(() => null)
        .then((size) => {
          running -= 1;
          // Pruned while measuring: the run left the board, keep nothing.
          if (inflight.delete(key)) {
            set((s) => ({ byKey: { ...s.byKey, [key]: size ?? null } }));
          }
          pump();
        });
    }
  };
  return {
    byKey: {},
    ensure: (runId, status, since, workspaceId) => {
      const key = diffSizeKey(runId, status, since);
      if (key in get().byKey || inflight.has(key)) return;
      inflight.add(key);
      queue.push({ key, workspaceId });
      pump();
    },
    prune: (runIds) => {
      const keep = new Set(runIds);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (!keep.has(runOfKey(queue[i].key))) {
          inflight.delete(queue[i].key);
          queue.splice(i, 1);
        }
      }
      for (const key of [...inflight]) if (!keep.has(runOfKey(key))) inflight.delete(key);
      const byKey = get().byKey;
      const stale = Object.keys(byKey).filter((k) => !keep.has(runOfKey(k)));
      if (stale.length === 0) return;
      const next = { ...byKey };
      for (const k of stale) delete next[k];
      set({ byKey: next });
    },
  };
});

/** Test hook: forget the queue and in-flight measures. */
export function resetDiffSizeQueueForTests() {
  inflight.clear();
  queue.length = 0;
  running = 0;
}

/** Lines a reviewer reads: added + removed. */
export const diffLines = (d: DiffSize) => d.added + d.removed;

/** The card's quiet size slot: "+120 −40 · 6 files", or "no changes". */
export function diffSizeLabel(d: DiffSize): string {
  if (d.files === 0) return "no changes";
  return `+${d.added} −${d.removed} · ${d.files === 1 ? "1 file" : `${d.files} files`}`;
}

/** The slot's tooltip: what was measured, against what. */
export function diffSizeTitle(d: DiffSize): string {
  const what = d.base ? `Against ${d.base}` : "Uncommitted changes (no base branch)";
  if (d.files === 0) return `${what}: no changes`;
  const skipped = d.untrackedSkipped
    ? ` (${d.untrackedSkipped} large untracked ${d.untrackedSkipped === 1 ? "entry" : "entries"} not line-counted)`
    : "";
  return `${what}: ${d.files === 1 ? "1 file" : `${d.files} files`} changed, +${d.added} −${d.removed} lines${skipped}`;
}

/**
 * The Settled band's order: oldest first (as given), or smallest diff first.
 * `sizeOf` returns the run's size, `null` when it has nothing to show (or
 * can't be measured), and `undefined` while it is still being measured.
 * "Smallest first" sorts only once every visible size is in — until then the
 * band keeps the oldest-first order, so the grid never jumps card by card
 * while sizes load. Runs with nothing to show go last, in their oldest-first
 * order; a missing size is never read as zero. Pure.
 */
export function orderSettled<T>(
  runs: T[],
  order: "oldest" | "smallest",
  sizeOf: (run: T) => DiffSize | null | undefined,
): T[] {
  if (order === "oldest") return runs;
  const sizes = runs.map(sizeOf);
  if (sizes.some((s) => s === undefined)) return runs;
  return runs
    .map((r, i) => ({ r, i, n: sizes[i] ? diffLines(sizes[i]!) : Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.r);
}

/**
 * diffSizeStore — how much code each Mission Control card holds for review.
 *
 * Computed ONCE per run per settled state (`<runId>:<status>`): a card that
 * pauses and later completes is measured again, but re-renders, re-opens of
 * the room and stage events never re-diff. `null` means "nothing to show"
 * (the workspace or its worktree is gone, or the diff failed) — never a made-up
 * zero.
 */
import { create } from "zustand";
import { ipc, type DiffSize } from "../lib/ipc";

interface DiffSizeState {
  /** Keyed by `diffSizeKey(runId, status)`; absent = not measured yet. */
  byKey: Record<string, DiffSize | null>;
  /** Measure the workspace for this run state, once. */
  ensure: (runId: string, status: string, workspaceId: string) => void;
}

export const diffSizeKey = (runId: string, status: string) => `${runId}:${status}`;

const inflight = new Set<string>();

export const useDiffSizeStore = create<DiffSizeState>((set, get) => ({
  byKey: {},
  ensure: (runId, status, workspaceId) => {
    const key = diffSizeKey(runId, status);
    if (key in get().byKey || inflight.has(key)) return;
    inflight.add(key);
    Promise.resolve()
      .then(() => ipc.workspaceDiffSize(workspaceId))
      .catch(() => null)
      .then((size) => {
        inflight.delete(key);
        set((s) => ({ byKey: { ...s.byKey, [key]: size ?? null } }));
      });
  },
}));

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
  return `${what}: ${d.files === 1 ? "1 file" : `${d.files} files`} changed, +${d.added} −${d.removed} lines`;
}

/** The Settled band's order: oldest first (as before), or smallest diff first.
 *  Runs not measured (or with nothing to show) keep their order after the
 *  measured ones — a missing size is never read as zero. Pure. */
export function orderSettled<T extends { id: string; status: string }>(
  runs: T[],
  order: "oldest" | "smallest",
  byKey: Record<string, DiffSize | null>,
): T[] {
  if (order === "oldest") return runs;
  const size = (r: T) => {
    const d = byKey[diffSizeKey(r.id, r.status)];
    return d ? diffLines(d) : Number.POSITIVE_INFINITY;
  };
  return runs
    .map((r, i) => ({ r, i, n: size(r) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.r);
}

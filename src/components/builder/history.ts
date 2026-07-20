// Pure undo/redo stack for the builder graph. Snapshots are recorded BEFORE a
// mutation; React state stays the single "present". No React imports — fully
// unit-testable, like graph.ts.

import type { StageEdge, StageNode } from "./graph";

export interface GraphSnapshot {
  nodes: StageNode[];
  edges: StageEdge[];
}

export interface HistoryStack {
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  /** Coalescing key of the last push; a repeat with the same key is skipped
   *  so a typing burst in one field stays a single undo step. */
  lastKey: string | null;
}

export const HISTORY_CAP = 100;

export function createHistory(): HistoryStack {
  return { past: [], future: [], lastKey: null };
}

/** Record `snap` (the state before a mutation). Clears the redo stack. */
export function pushSnapshot(h: HistoryStack, snap: GraphSnapshot, key: string | null = null): HistoryStack {
  if (key !== null && key === h.lastKey) return { ...h, future: [] };
  const past = [...h.past, snap];
  if (past.length > HISTORY_CAP) past.shift();
  return { past, future: [], lastKey: key };
}

export function canUndo(h: HistoryStack): boolean {
  return h.past.length > 0;
}

export function canRedo(h: HistoryStack): boolean {
  return h.future.length > 0;
}

/** Step back: `current` moves to the redo stack. Null when nothing to undo. */
export function undo(
  h: HistoryStack,
  current: GraphSnapshot,
): { stack: HistoryStack; restored: GraphSnapshot } | null {
  if (h.past.length === 0) return null;
  const restored = h.past[h.past.length - 1];
  return {
    stack: { past: h.past.slice(0, -1), future: [...h.future, current], lastKey: null },
    restored,
  };
}

/** Step forward again. Null when nothing to redo. */
export function redo(
  h: HistoryStack,
  current: GraphSnapshot,
): { stack: HistoryStack; restored: GraphSnapshot } | null {
  if (h.future.length === 0) return null;
  const restored = h.future[h.future.length - 1];
  return {
    stack: { past: [...h.past, current], future: h.future.slice(0, -1), lastKey: null },
    restored,
  };
}

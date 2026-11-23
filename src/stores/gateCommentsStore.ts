/**
 * gateCommentsStore — the director's inline comments on a parked stage's
 * artifact (#957), keyed by `gateKey(stage)` (the stage and this attempt).
 * The focus pane adds them; the decision bar sends them with Approve, Reject
 * or Send back and then clears them. They live only until that decision (or
 * until the app closes): a comment is a draft of feedback, not a record —
 * what was sent is kept on the stage's archived attempt.
 */
import { create } from "zustand";
import { normalizeQuote, type GateComment } from "../lib/gateComments";

interface GateCommentsState {
  byGate: Record<string, GateComment[]>;
  /** Add a comment; an empty quote or note adds nothing. */
  add: (gate: string, quote: string, note: string, at: number, len: number) => void;
  remove: (gate: string, commentId: string) => void;
  clear: (gate: string) => void;
}

let seq = 0;

export const useGateCommentsStore = create<GateCommentsState>((set) => ({
  byGate: {},
  add: (gate, quote, note, at, len) => {
    const q = normalizeQuote(quote);
    const n = note.trim();
    if (!q || !n) return;
    seq += 1;
    const comment: GateComment = { id: `c${seq}`, quote: q, note: n, at, len };
    set((s) => ({ byGate: { ...s.byGate, [gate]: [...(s.byGate[gate] ?? []), comment] } }));
  },
  remove: (gate, commentId) =>
    set((s) => {
      const list = s.byGate[gate];
      if (!list) return {};
      return { byGate: { ...s.byGate, [gate]: list.filter((c) => c.id !== commentId) } };
    }),
  clear: (gate) =>
    set((s) => {
      if (!(gate in s.byGate)) return {};
      const next = { ...s.byGate };
      delete next[gate];
      return { byGate: next };
    }),
}));

const NONE: GateComment[] = [];

/** The comments on one gate (a stable empty list when there are none). */
export function useGateComments(gate: string | null | undefined): GateComment[] {
  return useGateCommentsStore((s) => (gate ? s.byGate[gate] ?? NONE : NONE));
}

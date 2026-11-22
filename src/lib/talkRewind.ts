/**
 * Talk checkpoints (#958): the shapes the backend returns for a rewind and
 * the wording the dialog uses, pure so it is tested.
 */

export type RewindKind = "restored" | "removed" | "reverted";

export interface RewindChange {
  path: string;
  /** `restored`: gone now, back after · `removed`: created since · `reverted`: content goes back. */
  kind: RewindKind;
  /** Changed between this conversation's turns (by you, another conversation, a terminal). */
  outsideTalk: boolean;
}

export interface RewindPreview {
  messageId: number;
  /** The previewed tree; the rewind refuses if the files moved on since. */
  current: string;
  changes: RewindChange[];
}

/** The dialog's headline. */
export function rewindHeadline(changes: RewindChange[]): string {
  if (changes.length === 0) return "The files already match this turn.";
  const n = changes.length;
  return `${n} ${n === 1 ? "file goes" : "files go"} back to before this turn.`;
}

/** The amber line when a rewind would also undo changes made outside Talk. */
export function outsideNote(changes: RewindChange[]): string | null {
  const n = changes.filter((c) => c.outsideTalk).length;
  if (n === 0) return null;
  return `${n} of them ${n === 1 ? "was" : "were"} changed outside this conversation since; the rewind undoes that too.`;
}

export const KIND_LABEL: Record<RewindKind, string> = {
  restored: "restore",
  removed: "remove",
  reverted: "revert",
};

/** Backend errors arrive as `other: …`; the dialog shows the sentence. */
export function rewindError(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  return s.replace(/^other:\s*/, "");
}

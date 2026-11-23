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

/** Why a rewind leaves a path as it is on disk. */
export type UntouchedReason = "ignored" | "sensitive" | "exists" | "unchecked" | "failed";

export interface Untouched {
  path: string;
  reason: UntouchedReason;
}

export interface RewindPreview {
  messageId: number;
  /** The previewed tree; the rewind refuses if the files moved on since. */
  current: string;
  changes: RewindChange[];
  /** Paths that differ but that the rewind will not write or remove. */
  untouched: Untouched[];
}

/** What a rewind or an undo did. */
export interface RewindOutcome {
  /** Files written or removed. */
  changed: number;
  untouched: Untouched[];
  /** Set when it stopped part-way: some files were changed, some not. */
  error: string | null;
  /** The state before the rewind is kept and can be put back. */
  canUndo: boolean;
}

/** A turn that ran without a checkpoint, and why. */
export interface SkippedTurn {
  messageId: number;
  reason: string;
}

export interface TalkCheckpoints {
  /** User turns whose files can be rewound. */
  turns: number[];
  skipped: SkippedTurn[];
  /** The thread's last rewind can still be undone. */
  canUndo: boolean;
}

export const UNTOUCHED_LABEL: Record<UntouchedReason, string> = {
  ignored: "git-ignored",
  sensitive: "sensitive name",
  exists: "not in the snapshot",
  unchecked: "couldn't be checked",
  failed: "couldn't be removed",
};

export const UNTOUCHED_TITLE: Record<UntouchedReason, string> = {
  ignored: "Git-ignored now or at that turn, so the rewind doesn't write or remove it",
  sensitive: "Its name marks it as sensitive (an env file, a key), so it is never stored or rewound",
  exists: "Something the snapshot of your files doesn't hold is on disk at this path, so it isn't replaced",
  unchecked: "Its ignore status couldn't be established, so it is left as it is",
  failed: "It couldn't be removed",
};

/** The line above the list of paths a rewind leaves alone. */
export function untouchedNote(untouched: Untouched[]): string | null {
  const n = untouched.length;
  if (n === 0) return null;
  return `${n} ${n === 1 ? "path differs but is" : "paths differ but are"} left untouched.`;
}

/** The toast title after a rewind. */
export function rewoundTitle(outcome: RewindOutcome): string {
  const n = outcome.changed;
  const base = `Rewound ${n} ${n === 1 ? "file" : "files"}`;
  const left = outcome.untouched.length;
  return left > 0 ? `${base}; ${left} left untouched.` : `${base}.`;
}

/** The hover label of a turn that ran without a checkpoint. */
export function skippedLabel(reason: string): string {
  const why = reason.trim();
  return why ? `This turn has no checkpoint: ${why}` : "This turn has no checkpoint";
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

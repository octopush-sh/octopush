/**
 * What a Talk turn changed (#1152): the shape `talk_turn_changes` returns,
 * the ledger row's wording, and where each turn ends in the timeline. Pure,
 * so it is tested.
 */
import type { TalkBlock } from "./talkWork";

export interface TurnChange {
  path: string;
  status: "added" | "deleted" | "modified";
  /** Lines added and removed (0 and 0 for a binary file). */
  added: number;
  removed: number;
}

/** Review's "This turn" scope: the turn, and its ask as a short label. */
export interface TurnScope {
  threadId: string;
  messageId: number;
  /** The ask's first line, at most 40 characters. */
  label: string;
}

/** "4 files changed · +38 −6" (the counts are left out when both are 0). */
export function turnChangesSummary(changes: TurnChange[]): string {
  const n = changes.length;
  const files = `${n} ${n === 1 ? "file" : "files"} changed`;
  const added = changes.reduce((s, c) => s + c.added, 0);
  const removed = changes.reduce((s, c) => s + c.removed, 0);
  return added === 0 && removed === 0 ? files : `${files} · +${added} −${removed}`;
}

/** The file names the row lists, comma-separated, in the order given. */
export function turnChangesNames(changes: TurnChange[]): string {
  return changes.map((c) => c.path.slice(c.path.lastIndexOf("/") + 1)).join(", ");
}

/** The first non-empty line of an ask, at most 40 characters. */
export function turnLabel(ask: string): string {
  const first = ask.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** For each block that ends a turn (the last block before the next ask, or
 *  the last block of all), the id of that turn's ask. A turn with nothing
 *  after its ask ends on the ask itself. */
export function turnEnds(blocks: TalkBlock[]): Map<number, number> {
  const ends = new Map<number, number>();
  let ask: number | null = null;
  blocks.forEach((b, i) => {
    if (b.kind === "message" && b.message.role === "user") {
      if (ask !== null && i > 0) ends.set(i - 1, ask);
      ask = b.message.id;
    }
  });
  if (ask !== null && blocks.length > 0) ends.set(blocks.length - 1, ask);
  return ends;
}

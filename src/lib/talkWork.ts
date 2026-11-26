// Talk's timeline, grouped for reading. The model's process — the narration it
// writes before a round of tool calls, and the calls themselves — becomes one
// WORK block hung on a single hairline, so a turn reads as three registers:
// the director's ask (a panel inset), the work (quiet ledger rows), and the
// answer (flush, serif lead). Inside a work block, consecutive tool calls are
// a ROUND; a round longer than ROUND_FOLD_AT folds into one summary row.
//
// Pure: no React, no store. ChatCanvas renders what this returns.
import type { ConversationItem, ToolExecution } from "../stores/chatStore";

/** A round of more calls than this renders folded, as one summary row. */
export const ROUND_FOLD_AT = 5;

export type WorkEntry =
  | { kind: "narration"; id: number; text: string }
  | { kind: "round"; id: number; tools: Array<{ id: number; tool: ToolExecution }> };

export type TalkBlock =
  | { kind: "work"; id: number; entries: WorkEntry[]; calls: number }
  | Exclude<ConversationItem, { kind: "tool" } | { kind: "narration" }>;

/** Groups each run of consecutive narration and tool items into one work
 *  block; every other item (messages, crews, errors) passes through in order
 *  and ends the run. A block's id is its first item's, so React keys stay
 *  stable as later items of the same run land. */
export function groupWork(items: ConversationItem[]): TalkBlock[] {
  const blocks: TalkBlock[] = [];
  let work: Extract<TalkBlock, { kind: "work" }> | null = null;
  for (const item of items) {
    if (item.kind !== "tool" && item.kind !== "narration") {
      work = null;
      blocks.push(item);
      continue;
    }
    if (!work) {
      work = { kind: "work", id: item.id, entries: [], calls: 0 };
      blocks.push(work);
    }
    if (item.kind === "narration") {
      work.entries.push({ kind: "narration", id: item.id, text: item.text });
      continue;
    }
    const last = work.entries[work.entries.length - 1];
    if (last && last.kind === "round") {
      last.tools.push({ id: item.id, tool: item.tool });
    } else {
      work.entries.push({ kind: "round", id: item.id, tools: [{ id: item.id, tool: item.tool }] });
    }
    work.calls += 1;
  }
  return blocks;
}

/** "1 tool call", "7 tool calls". */
export function toolCallCount(n: number): string {
  return `${n} tool call${n === 1 ? "" : "s"}`;
}

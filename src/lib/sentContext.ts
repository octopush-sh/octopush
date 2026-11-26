/**
 * The `@` context an ask was sent with (#1150), as saved on its row
 * (`chat_messages.context_blocks`). The row's `content` stays the full text the
 * model received; each entry says where one block sits in it, so the thread
 * shows the ask as typed with a chip per block, and later turns re-send the
 * blocks abridged (`chat_history.rs`). Offsets are UTF-16 units, the way
 * `String.slice` counts.
 */

import type { ContextRef } from "./talkContext";

export interface SentContextBlock {
  /** The `@` token, unquoted. */
  token: string;
  kind: ContextRef["kind"];
  /** The chip's label (`chipLabel`). */
  label: string;
  /** Estimated tokens of the block as sent. */
  tokens: number;
  start: number;
  end: number;
  /** Why the block wasn't included (the secret guard left it out, or it
   *  couldn't be read); its place in `content` holds that note. */
  notIncluded?: string;
}

const KINDS = new Set(["file", "folder", "session", "diff"]);

function isBlock(b: unknown): b is SentContextBlock {
  const o = (b ?? {}) as Record<string, unknown>;
  return typeof o.token === "string" && typeof o.label === "string" && typeof o.tokens === "number" &&
    KINDS.has(o.kind as string) && Number.isInteger(o.start) && Number.isInteger(o.end);
}

/** A row's blocks, in order, or null when it has none — an older row, or a
 *  record that doesn't fit its content, renders exactly as it was sent. */
export function parseSentContext(
  contextBlocks: string | null | undefined,
  content: string,
): SentContextBlock[] | null {
  let parsed: unknown = null;
  try {
    parsed = contextBlocks ? JSON.parse(contextBlocks) : null;
  } catch {
    /* not a record: render the row as sent */
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isBlock)) return null;
  let at = 0;
  for (const b of parsed) {
    if (b.start < at || b.end < b.start || b.end > content.length) return null;
    at = b.end;
  }
  return parsed;
}

/** What the user typed: the content before its first block. */
export function typedText(content: string, blocks: SentContextBlock[]): string {
  return content.slice(0, blocks[0].start);
}

/** One block as the model received it, without the blank line before it. */
export function blockBody(content: string, block: SentContextBlock): string {
  return content.slice(block.start, block.end).replace(/^\n+/, "");
}

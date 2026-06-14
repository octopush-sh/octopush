import type { ChatMessage } from "./types";

/** Soft cap for inline-displayed titles in the Companion history list. */
const TITLE_MAX_LEN = 60;

/** Placeholder used when a workspace's conversation has no user messages yet. */
const PLACEHOLDER_TITLE = "New conversation";

/**
 * Derive a human-readable title for a chat from its message stream.
 *
 *   - If the first user message is short, use it verbatim.
 *   - If it's long, truncate at a word boundary near `TITLE_MAX_LEN` and
 *     append an ellipsis.
 *   - If no user message exists yet, fall back to the placeholder.
 *
 * The output is always a single line: line breaks are collapsed to spaces.
 */
export function deriveChatTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  if (!firstUser) return PLACEHOLDER_TITLE;

  const oneLine = firstUser.content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_LEN) return oneLine;

  // Truncate at the last whitespace within the soft cap so we don't slice
  // mid-word. If the first word is already longer than the cap, just cut hard.
  const slice = oneLine.slice(0, TITLE_MAX_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = lastSpace > 30 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed}…`;
}

/**
 * Format a relative timestamp for the meta line under a chat title.
 * The input is the most recent message's `createdAt` (ISO string from the
 * backend). Returns short shapes like `just now`, `5m ago`, `Yesterday`,
 * or a localized date when older than a week.
 */
export function deriveChatMeta(messages: ChatMessage[], now: Date = new Date()): string {
  const last = messages[messages.length - 1];
  if (!last) return "NEW";
  return formatRelTime(last.createdAt, now);
}

/** Short uppercase relative time (`JUST NOW`, `5M AGO`, `YESTERDAY`, a date)
 *  from an ISO timestamp. Shared by the chat meta line and the thread list. */
export function formatRelTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 45) return "JUST NOW";
  if (diffMin < 60) return `${diffMin}M AGO`;
  if (diffHr < 24) return `${diffHr}H AGO`;
  if (diffDay === 1) return "YESTERDAY";
  if (diffDay < 7) return `${diffDay}D AGO`;

  // Older than a week — fall back to a short locale-aware date.
  return then
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

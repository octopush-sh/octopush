import type { ChatMessage } from "./types";
import { parseSentContext, typedText } from "./sentContext";

/** Soft cap for inline-displayed titles in the Companion history list. */
const TITLE_MAX_LEN = 60;

/** Placeholder used when a workspace's conversation has no user messages yet. */
export const PLACEHOLDER_TITLE = "New conversation";

/** A thread's title before anything named it (`Conversation` is the older one). */
export function isPlaceholderTitle(title: string): boolean {
  return title === PLACEHOLDER_TITLE || title === "Conversation";
}

// A ticket key (`GUIDE-123`). Prefixes that are standards or versions, not
// trackers (`UTF-8`, `SHA-256`), don't count.
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-[1-9]\d*)\b(?![.-]\d)/g;
const NOT_KEYS = new Set(["UTF", "SHA", "ISO", "GPT", "AES", "RSA", "CVE", "RFC", "HTTP", "TLS", "SSL", "IPV", "MP", "ES", "PEP"]);
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi;

function keysIn(text: string): string[] {
  return [...text.matchAll(KEY_RE)].map((m) => m[1]).filter((k) => !NOT_KEYS.has(k.slice(0, k.indexOf("-"))));
}

/** The first ticket key a message names, in a tracker URL or as text; null without one. */
export function ticketKey(text: string): string | null {
  for (const url of text.match(URL_RE) ?? []) {
    const key = keysIn(decodeSafe(url))[0];
    if (key) return key;
  }
  return keysIn(text.replace(URL_RE, " "))[0] ?? null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A URL as a title reads it: its ticket key, else its host and the last two
 *  segments of its path (`github.com/…/pull/42`). */
export function shortUrl(url: string): string {
  const key = keysIn(decodeSafe(url))[0];
  if (key) return key;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/[.,;:!?]+$/, ""));
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segs = parsed.pathname.split("/").filter(Boolean).map(decodeSafe);
  if (segs.length === 0) return host;
  if (segs.length <= 2) return `${host}/${segs.join("/")}`;
  return `${host}/…/${segs.slice(-2).join("/")}`;
}

/** What a title is made from: the text the user typed (no `@` blocks),
 *  without `/skill` tokens, `@file` mentions or fenced code, URLs shortened,
 *  on one line. */
export function titleSource(content: string, contextBlocks?: string | null): string {
  const blocks = parseSentContext(contextBlocks, content);
  const typed = blocks ? typedText(content, blocks) : content;
  return typed
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/(^|\s)\/[A-Za-z][\w:-]*(?=\s|$)/g, " ")
    .replace(/(^|\s)@(?:"[^"]*"|\S+)/g, " ")
    .replace(URL_RE, (u) => shortUrl(u))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive a human-readable title for a chat from its message stream: the
 * fallback, and the title until a generated one lands.
 *
 *   - Read the first user message through `titleSource` (skills, mentions,
 *     code and URLs tidied).
 *   - If it's short, use it as is; if long, truncate at a word boundary near
 *     `TITLE_MAX_LEN` and append an ellipsis.
 *   - If no user message exists yet, fall back to the placeholder.
 *
 * The output is always a single line.
 */
export function deriveChatTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  if (!firstUser) return PLACEHOLDER_TITLE;

  // A message that was only a skill and its mention still reads as itself.
  const oneLine = titleSource(firstUser.content, firstUser.contextBlocks) || firstUser.content.replace(/\s+/g, " ").trim();
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
 * backend). Returns short shapes like `14:32`, `YESTERDAY`, `3D AGO`, or a
 * localized date when older than a week.
 */
export function deriveChatMeta(messages: ChatMessage[], now: Date = new Date()): string {
  const last = messages[messages.length - 1];
  if (!last) return "NEW";
  return formatRelTime(last.createdAt, now);
}

/** Short uppercase time of last activity from an ISO timestamp, for the chat
 *  list's meta line: the clock time today (`14:32`), then `YESTERDAY`,
 *  `3D AGO`, a date. Today's rows carry a precise time rather than a
 *  relative bucket (`JUST NOW`, `5M AGO`) so rows active in the same stretch
 *  still read apart. */
export function formatRelTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  // Calendar days between the two local dates (not 24h periods), so 23:50
  // yesterday reads YESTERDAY at 00:10 today.
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDay = Math.max(0, Math.round((dayStart(now) - dayStart(then)) / 86_400_000));

  if (diffDay === 0) {
    return then
      .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      .toUpperCase();
  }
  if (diffDay === 1) return "YESTERDAY";
  if (diffDay < 7) return `${diffDay}D AGO`;

  // Older than a week — fall back to a short locale-aware date.
  return then
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

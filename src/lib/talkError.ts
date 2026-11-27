// What Talk's error card says and offers for a turn that ended on an error
// (#1151). The kind is the backend's `ProviderErrorKind`, kept on the error
// row; a row from before it was kept reads as `other`.

import type { ChatMessage } from "./types";

export type TalkErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "network"
  | "auth"
  | "bad_request"
  | "spend_cap"
  | "other";

/** The card's one action: continue the turn, set the key, or copy the text. */
export type TalkErrorAction = "retry" | "configure" | "copy";

const KINDS: readonly TalkErrorKind[] = [
  "rate_limit",
  "overloaded",
  "server_error",
  "network",
  "auth",
  "bad_request",
  "spend_cap",
  "other",
];

/** A stored kind, `other` when absent or unknown. */
export function errorKindOf(kind: string | null | undefined): TalkErrorKind {
  return KINDS.includes(kind as TalkErrorKind) ? (kind as TalkErrorKind) : "other";
}

/** The kind of an error that was never saved as a row (the banner: the
 *  send was refused before the turn began), from its text. */
export function bannerErrorKind(text: string): TalkErrorKind {
  return text.includes("API key") ? "auth" : "other";
}

/** Transient failures whose retries ran out offer "Try again"; an auth
 *  failure offers the key; everything else, its details. */
export function errorAction(kind: TalkErrorKind): TalkErrorAction {
  switch (kind) {
    case "rate_limit":
    case "overloaded":
    case "server_error":
    case "network":
      return "retry";
    case "auth":
      return "configure";
    default:
      return "copy";
  }
}

export const ACTION_LABEL: Record<TalkErrorAction, string> = {
  retry: "Try again",
  configure: "Configure API key",
  copy: "Copy error details",
};

/** What happened, in words. */
export function errorHeadline(kind: TalkErrorKind): string {
  switch (kind) {
    case "rate_limit":
      return "The rate limit didn't clear.";
    case "overloaded":
      return "The model is overloaded.";
    case "server_error":
      return "The provider had a server error.";
    case "network":
      return "The connection to the provider dropped.";
    case "auth":
      return "The API key is missing or was refused.";
    case "bad_request":
      return "The provider rejected the request.";
    case "spend_cap":
      return "Your API spend limit is reached. Waiting won't lift it.";
    case "other":
      return "The turn ended on an error.";
  }
}

/** How many tool rounds the failed turn ran before the error row at
 *  `index`: its `assistant_tool_use` rows since the ask (an earlier
 *  "Try again" of the same turn included). */
export function roundsKept(messages: readonly ChatMessage[], index: number): number {
  let rounds = 0;
  for (let i = index - 1; i >= 0; i--) {
    const role = messages[i].role as string;
    if (role === "user") break;
    if (role === "assistant_tool_use") rounds++;
  }
  return rounds;
}

/** What of the turn survives the error. */
export function keptLine(rounds: number): string {
  return rounds > 0 ? `Work up to round ${rounds} is kept.` : "Your message is kept.";
}

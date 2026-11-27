import { ipc } from "./ipc";
import { isBudgetExceeded } from "./budgetError";
import type { ChatMessage } from "./types";
import { deriveChatTitle, isPlaceholderTitle, ticketKey, titleSource } from "./chatTitle";

// A Talk thread's generated title (#1137): after the first answer, one small
// call on the conversation's own provider, fast tier (`generate_chat_title`),
// billed to the thread as origin `title`. Anything short of a clean answer in
// time leaves the derived title in place.

/** How long the title call may take before the derived title stays. */
export const TITLE_TIMEOUT_MS = 10_000;
/** The answer's share of the prompt. */
const ANSWER_CHARS = 1_500;
/** Words a generated title may hold, after the ticket key. */
const TITLE_WORDS = 6;

const TITLE_SYSTEM =
  "You write the title of a conversation between a developer and a coding assistant, " +
  "for a list of conversations. Reply with the title alone: at most 6 words that say what " +
  "the conversation is about, written in the language the developer wrote in, with no " +
  "quotes, no trailing period and nothing else.";

/** The call's system prompt and prompt, from the thread's first ask and the
 *  start of its answer; null when there is no ask or no answer yet. */
export function titleRequest(messages: ChatMessage[]): { system: string; prompt: string; key: string | null } | null {
  const ask = messages.find((m) => m.role === "user" && m.content.trim());
  if (!ask) return null;
  const answer = messages
    .filter((m) => m.role === "assistant" && m.id > ask.id && m.content.trim())
    .map((m) => m.content.trim())
    .join("\n\n")
    .slice(0, ANSWER_CHARS);
  if (!answer) return null;
  const source = titleSource(ask.content, ask.contextBlocks);
  const typed = source || ask.content.trim();
  // The key comes from what the user typed, never from an `@` block's body or
  // fenced code; a tracker URL typed in the ask still reads as its key.
  const key = ticketKey(source);
  const system = key
    ? `${TITLE_SYSTEM} The conversation is about ${key}: start the title with "${key} · ".`
    : TITLE_SYSTEM;
  return { system, prompt: `The developer asked:\n${typed}\n\nThe assistant answered:\n${answer}`, key };
}

const QUOTES = /^[\s"'`“”‘’«»„]+|[\s"'`“”‘’«»„]+$/g;

/** A model's reply as a title: its first line, without a `Title:` label,
 *  quotes or a trailing period, at most six words, led by the ticket key when
 *  there is one. Null when nothing usable is left. */
export function cleanGeneratedTitle(raw: string, key: string | null): string | null {
  let t = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^\*+|\*+$/g, "").replace(/^title\s*:\s*/i, "");
  t = t.replace(QUOTES, "").replace(/[.。]+$/, "").replace(QUOTES, "");
  if (key) {
    const lead = new RegExp(`^${key}\\b\\s*[·:|–—-]?\\s*`);
    t = t.replace(lead, "");
  }
  const words = t.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, TITLE_WORDS);
  const body = words.join(" ").replace(/[\s.,;:·|–—-]+$/, "");
  if (!body) return null;
  return key ? `${key} · ${body}` : body;
}

/** Whether a thread's title is still the one Octopush gave it (the
 *  placeholder or the derived title), so a generated title may replace it. A
 *  title the user set, or one a fork or an import brought, is never replaced
 *  on its own. */
export function isAutoTitle(title: string, messages: ChatMessage[]): boolean {
  return isPlaceholderTitle(title) || title === deriveChatTitle(messages);
}

/** Why no title came back: nothing to title yet, the provider has no fast
 *  tier, a budget limit blocked the call, the call failed or ran late, or
 *  (`busy`, from regenerate only) a title call for the thread is already
 *  running. */
export type TitleFailure = "no-answer" | "no-fast-tier" | "budget" | "failed" | "busy";

export type TitleOutcome = { title: string } | { failure: TitleFailure };

/** The info toast for a "Regenerate title" that brought nothing back: what
 *  actually happened, and what the user can do about it. */
export function titleFailureToast(failure: TitleFailure): { title: string; body: string } {
  const title = "The title stays as it is";
  switch (failure) {
    case "no-answer":
      return { title, body: "This conversation has no answer to title yet. Try again once the first reply lands." };
    case "no-fast-tier":
      return {
        title,
        body: "This conversation's provider has no fast model to write titles. Map a fast tier for it in Settings › Models.",
      };
    case "budget":
      return { title, body: "A budget limit is blocking new spend, so no title call was made." };
    case "failed":
      return { title, body: "The title call failed or took longer than 10 seconds. Try again in a moment." };
    case "busy":
      return {
        title: "A title is on its way",
        body: "A title is already being written for this conversation. It appears when that call finishes.",
      };
  }
}

/** Ask for a thread's title. A failure — keep the derived title — when there
 *  is nothing to title yet, the provider has no fast tier, a budget blocks
 *  it, the call fails or it takes longer than `timeoutMs`. */
export async function requestChatTitle(
  args: { threadId: string; workspaceId: string; model: string; messages: ChatMessage[] },
  timeoutMs: number = TITLE_TIMEOUT_MS,
): Promise<TitleOutcome> {
  const req = titleRequest(args.messages);
  if (!req) return { failure: "no-answer" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    const res = await Promise.race([
      ipc.generateChatTitle({
        threadId: args.threadId,
        workspaceId: args.workspaceId,
        model: args.model,
        system: req.system,
        prompt: req.prompt,
      }),
      late,
    ]);
    if (res === "late") return { failure: "failed" };
    if (!res) return { failure: "no-fast-tier" };
    const title = cleanGeneratedTitle(res.text, req.key);
    return title ? { title } : { failure: "failed" };
  } catch (e) {
    return { failure: isBudgetExceeded(e) ? "budget" : "failed" };
  } finally {
    clearTimeout(timer);
  }
}

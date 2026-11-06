// When does looking at something count as having seen it?
//
// `attentionStore` flags a workspace when a background chat turn finishes or a
// terminal rings. The flag has to clear once the user is actually on the
// surface that raised it — but no sooner, or the signal is swallowed before it
// can point anywhere. Kept pure and store-free because the rule is the subtle
// part and App is not a testable place to keep it.

import type { AttentionFlag } from "../stores/attentionStore";
import type { ClaudeWaitReason } from "./claudeWaiting";
import type { WorkspaceMode } from "./modes";
import type { PtyAttentionReason } from "./types";

/** The mode a flag is asking the user to visit. */
export function modeForFlag(flag: AttentionFlag): WorkspaceMode {
  return flag.kind === "chat" ? "talk" : "run";
}

/**
 * True when the user's current focus means they have seen what the flag was
 * pointing at.
 *
 * A terminal flag names the session that rang, and Run mode holds several: being
 * in Run is not enough, the user has to be looking at *that* session — otherwise
 * entering Run to work in session A would silently erase the marker session B
 * raised. Flags with no terminal id (chat pings, and terminal pings from a
 * daemon too old to name one) clear on the mode alone, as they always did.
 */
export function shouldClearAttention(
  flag: AttentionFlag | undefined,
  activeMode: WorkspaceMode,
  activeTerminalId: string | null,
): boolean {
  if (!flag) return false;
  if (activeMode !== modeForFlag(flag)) return false;
  if (flag.kind === "terminal" && flag.terminalId) {
    return flag.terminalId === activeTerminalId;
  }
  return true;
}

/** Something that happened to one session's pane. */
export type ShownWaitingEvent =
  /** `pty://attention` arrived; `shown` is whether the pane is on screen. */
  | { type: "attention"; reason: PtyAttentionReason | null; shown: boolean }
  /** The user typed into the pane. */
  | { type: "input" }
  /** The pane became the one the user works in. */
  | { type: "focus" }
  /** `pty://settled`: Claude Code's `Stop` hook — the turn is over. */
  | { type: "settled" }
  /** The pane left the screen (left the view, mode switch, closed). */
  | { type: "hidden" };

/**
 * What an on-screen session is waiting on after `event`, given `current`.
 *
 * Only Claude Code's own hook reasons (`permission`, `input`) mark a pane on
 * screen: the daemon's `idle` guess and an event with no reason (an older
 * daemon or CLI) leave it as it was. A pane that is off screen is never
 * marked — the rail's attention flag points at it instead. The user answering
 * (typing, focusing the pane), the turn ending, or the pane leaving the
 * screen clears the mark.
 */
export function nextShownWaiting(
  current: ClaudeWaitReason | null,
  event: ShownWaitingEvent,
): ClaudeWaitReason | null {
  if (event.type !== "attention") return null;
  if (!event.shown) return null;
  const r = event.reason;
  return r === "permission" || r === "input" ? r : current;
}

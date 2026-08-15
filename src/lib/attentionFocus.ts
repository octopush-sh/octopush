// When does looking at something count as having seen it?
//
// `attentionStore` flags a workspace when a background chat turn finishes or a
// terminal rings. The flag has to clear once the user is actually on the
// surface that raised it — but no sooner, or the signal is swallowed before it
// can point anywhere. Kept pure and store-free because the rule is the subtle
// part and App is not a testable place to keep it.

import type { AttentionFlag } from "../stores/attentionStore";
import type { WorkspaceMode } from "./modes";

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

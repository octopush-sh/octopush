// When the stored claude.ai sign-in ends: what a CLI stage's `result` event
// last reported (`credential_expires_at`, Claude Code 2.1.318+; kept by
// `claude_login.rs`). Pure helpers for the Routines and Mission Control note.
// Older CLIs never report it, and then nothing shows.
import type { ClaudeLoginExpiry } from "./ipc";

/** A stage reported the sign-in end; mirrors `claude_login::LOGIN_EVENT`. */
export const LOGIN_EVENT = "claude-login://updated";

/** Within this many days the note appears; mirrors `claude_login::WARN_DAYS`. */
export const WARN_DAYS = 10;

/** `12 Dec`, the same shape as the Readiness row. */
export function loginDay(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export type LoginNote = { tone: "soon" | "ended"; text: string };

/** The one-line note: within `WARN_DAYS` of the end, or after it; null
 *  otherwise (or with nothing reported). */
export function loginNote(login: ClaudeLoginExpiry | null, nowMs: number): LoginNote | null {
  if (!login || !Number.isFinite(login.expiresAt)) return null;
  const left = login.expiresAt * 1000 - nowMs;
  const day = loginDay(login.expiresAt);
  if (left <= 0) {
    return { tone: "ended", text: `Your Claude sign-in ended ${day} · CLI stages and Routines can't run until you sign in again` };
  }
  if (left <= WARN_DAYS * 86_400_000) {
    return { tone: "soon", text: `Your Claude sign-in ends ${day} · sign in again so overnight crews keep running` };
  }
  return null;
}

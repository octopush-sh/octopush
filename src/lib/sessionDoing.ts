// What a Run session is doing, in one mono phrase — the session line's label
// and the pane caption say it with the same words.

import { ROLE_WORD } from "./sessionRole";
import { describeSetup, type SetupRun } from "./setupRun";
import { claudeWaitingCopy, type ClaudeWaitReason } from "./claudeWaiting";
import type { TerminalState } from "../stores/terminalsStore";

type Session = Pick<TerminalState, "role" | "busy" | "command" | "failed" | "starting" | "running">;

/** How the phrase should read: `live` for a running command, `failed` for a
 *  session that didn't start, `quiet` for everything at rest. */
export type DoingTone = "live" | "failed" | "quiet";

export interface SessionDoing {
  text: string;
  tone: DoingTone;
}

/**
 * The phrase and its tone. In order: a session that didn't start says so; one
 * whose shell hasn't drawn yet is starting; Claude Code blocked on the user
 * comes before what it runs; a setup run speaks for its session until it
 * succeeds; a busy session reports its command — "running" when the platform
 * couldn't resolve one, never the role phrase, which would read "shell at the
 * prompt" while a build runs; otherwise the (sticky) role phrase.
 */
export function sessionDoing(
  session: Session,
  { wait, setup }: { wait?: ClaudeWaitReason | null; setup?: SetupRun | null } = {},
): SessionDoing {
  if (session.failed) return { text: "didn't start", tone: "failed" };
  if (session.starting) return { text: "starting", tone: "quiet" };
  if (wait) return { text: claudeWaitingCopy(wait), tone: "quiet" };
  if (setup && setup.status !== "ok") {
    return { text: describeSetup(setup), tone: setup.status === "failed" ? "failed" : "live" };
  }
  if (session.busy) return { text: session.command ?? "running", tone: "live" };
  return { text: ROLE_WORD[session.role], tone: "quiet" };
}

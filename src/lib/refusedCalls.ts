/** Every journal notice about a tool call Claude Code refused starts with
 *  this (mirrors `cli_runner::REFUSED_NOTICE_PREFIX`). */
export const REFUSED_NOTICE_PREFIX = "refused · ";

/** True for a "refused · Bash · git push" journal notice. */
export function isRefusedNotice(text: string): boolean {
  return text.startsWith(REFUSED_NOTICE_PREFIX);
}

/** The stage's amber note: "1 tool call refused" / "3 tool calls refused". */
export function refusedCallsNote(count: number): string {
  return `${count} tool call${count === 1 ? "" : "s"} refused`;
}

export const REFUSED_CALLS_TITLE =
  "Claude Code refused these calls with nobody to ask, so they never ran. Each is listed in the stage's journal.";

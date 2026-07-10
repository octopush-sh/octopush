import type { LiveEntry } from "./ipc";

/** One-line "current activity" from the most recent meaningful live entry —
 *  the single ticker vocabulary shared by every live Direct surface (RunFlow
 *  stage cards, Mission Control crew cards). */
export function lastActivity(entries: LiveEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "tool") return `§ ${e.tool}${e.hint ? " " + e.hint : ""}`;
    if (e.kind === "text") return e.text.split("\n")[0].slice(0, 60);
  }
  return "";
}

/** The latest verdict notice (for a finished review), or "". */
export function lastNotice(entries: LiveEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "notice") return e.text;
  }
  return "";
}

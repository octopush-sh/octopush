import type { SyncAttempt, SyncKind } from "./types";

/** The muted mono line under an enabled Settings › Account › Sync toggle
 *  (#518). Wording approved by the PM on the issue; keep it exact. */
export interface SyncStatusLine {
  text: string;
  /** `warning` (a failed attempt) renders amber (`text-octo-warning`);
   *  `mute` is the default. */
  tone: "mute" | "warning";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local `HH:mm`, prefixed with the date (`Nov 7`, plus the year when it
 *  isn't this year) when the attempt wasn't today. */
export function formatAttemptTime(at: Date, now: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  const date = at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}

/** What to show for one kind's last attempt. `null` (show nothing) when the
 *  toggle is off, nothing was recorded, or the record is unreadable. */
export function syncStatusLine(
  kind: SyncKind,
  enabled: boolean,
  attempt: SyncAttempt | null | undefined,
  now: Date = new Date(),
): SyncStatusLine | null {
  if (!enabled || !attempt) return null;
  const at = new Date(attempt.at);
  if (Number.isNaN(at.getTime())) return null;
  const when = formatAttemptTime(at, now);
  if (attempt.outcome === "failed") {
    const status = attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : "";
    return {
      text: `Last attempt failed ${when}${status} · Octopush retries with the next run`,
      tone: "warning",
    };
  }
  if (attempt.outcome === "sent") {
    const noun = kind === "history" ? "run" : "item";
    const count = attempt.count;
    return { text: `Last sent ${when} · ${count} ${noun}${count === 1 ? "" : "s"}`, tone: "mute" };
  }
  return null;
}

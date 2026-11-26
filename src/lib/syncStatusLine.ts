import type { LibraryRejection, SyncAttempt, SyncKind } from "./types";

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

/** Why the sync service refused a library item, in a few words (#799).
 *  `oversize` is the service's 64,000-byte limit, which this Mac also
 *  enforces before sending. */
export function rejectionReason(reason: string): string {
  switch (reason) {
    case "oversize":
      return "over the 64,000-byte limit";
    case "bad_stamp":
      return "unreadable edit time";
    case "future_stamp":
      return "edit time over a day ahead of the sync service";
    default:
      return "refused by the sync service";
  }
}

/** How many unsent items the line names before "+N more". */
export const UNSENT_NAMED = 2;

/** The amber line under the library toggle naming the items that are not
 *  synced and why. `null` when the toggle is off or nothing is unsent. */
export function syncUnsentLine(
  enabled: boolean,
  rejected: LibraryRejection[] | null | undefined,
): SyncStatusLine | null {
  if (!enabled || !rejected || rejected.length === 0) return null;
  const named = rejected.slice(0, UNSENT_NAMED).map((r) => {
    const noun = r.kind === "role" ? "role" : "pipeline";
    const name = r.name?.trim() || r.id;
    return `${noun} "${name}" (${rejectionReason(r.reason)})`;
  });
  const more = rejected.length - named.length;
  const tail = more > 0 ? ` · +${more} more` : "";
  return { text: `Not synced · ${named.join(" · ")}${tail}`, tone: "warning" };
}

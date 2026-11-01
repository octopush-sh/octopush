// The Claude plan headroom model: what a subscription-authenticated CLI
// stage last reported about the plan's rolling windows (`rate_limit_event`,
// kept by `claude_plan.rs`). Pure helpers for the Companion line and the
// Usage card. A snapshot is what the CLI said when it was seen — never
// extrapolated — so every rendering carries its age.
import type { PlanSnapshot } from "./ipc";

/** A stage reported plan windows (payload `{ windows }`); mirrors
 *  `claude_plan::PLAN_EVENT`. */
export const PLAN_EVENT = "plan://updated";

/** True when one of the stages runs Claude Code headless — the only place
 *  plan windows come from. Mirrors `cli_runner::dialect_for_model`. */
export function runsClaudeCli(stages: ReadonlyArray<{ substrate: string; agentModel: string }>): boolean {
  return stages.some((s) => {
    if (s.substrate !== "cli") return false;
    const m = s.agentModel.toLowerCase();
    return !(m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("codex"));
  });
}

/** CSS color variable for a tone (bars). */
export function toneColor(t: PlanTone): string {
  return t === "limited" ? "var(--color-octo-rouge)" : t === "near" ? "var(--color-octo-warning)" : "var(--color-octo-sage)";
}

/** At or above this fraction a window reads as near its limit (amber). */
export const NEAR_LIMIT = 0.8;

/** calm (sage) · near (amber) · limited (rouge). */
export type PlanTone = "calm" | "near" | "limited";

const ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

/** Short label for the one-line meta: `5h`, `week`, `week opus`, … */
export function windowLabel(kind: string): string {
  if (kind === "five_hour") return "5h";
  if (kind === "seven_day") return "week";
  if (kind.startsWith("seven_day_")) return `week ${kind.slice("seven_day_".length).replace(/_/g, " ")}`;
  return kind.replace(/_/g, " ");
}

/** Full name for the Usage card and the warning copy. */
export function windowName(kind: string): string {
  if (kind === "five_hour") return "5-hour window";
  if (kind === "seven_day") return "weekly window";
  if (kind.startsWith("seven_day_")) {
    const model = kind.slice("seven_day_".length).replace(/_/g, " ");
    return `weekly ${model.charAt(0).toUpperCase()}${model.slice(1)} window`;
  }
  return `${kind.replace(/_/g, " ")} window`;
}

/** Known windows first, in a fixed order; unknown kinds after, by name. */
export function orderWindows(ws: PlanSnapshot[]): PlanSnapshot[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i < 0 ? ORDER.length : i;
  };
  return [...ws].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

/** True when the window has reset since it was seen: its figure no longer
 *  describes the current window. */
export function hasReset(w: PlanSnapshot, nowMs: number): boolean {
  return w.resetsAt != null && w.resetsAt * 1000 <= nowMs;
}

export function windowTone(w: PlanSnapshot, nowMs: number): PlanTone {
  if (hasReset(w, nowMs)) return "calm";
  if (w.status === "rejected") return "limited";
  if ((w.utilization != null && w.utilization >= NEAR_LIMIT) || w.status === "allowed_warning") return "near";
  return "calm";
}

const TONE_RANK: Record<PlanTone, number> = { calm: 0, near: 1, limited: 2 };

/** The window that most needs attention (ties: the display order). */
export function worstWindow(ws: PlanSnapshot[], nowMs: number): PlanSnapshot | null {
  let worst: PlanSnapshot | null = null;
  for (const w of orderWindows(ws)) {
    if (!worst || TONE_RANK[windowTone(w, nowMs)] > TONE_RANK[windowTone(worst, nowMs)]) worst = w;
  }
  return worst;
}

export function planTone(ws: PlanSnapshot[], nowMs: number): PlanTone {
  const w = worstWindow(ws, nowMs);
  return w ? windowTone(w, nowMs) : "calm";
}

/** Tailwind text class for a tone (existing tokens only). */
export function toneClass(t: PlanTone): string {
  return t === "limited" ? "text-octo-rouge" : t === "near" ? "text-octo-warning" : "text-octo-sage";
}

/** `62%`; `—` when the CLI did not say. */
export function pctLabel(u: number | null): string {
  return u == null ? "—" : `${Math.round(u * 100)}%`;
}

/** Reset time in the viewer's clock: `19:40` within a day, else `Tue 19:40`. */
export function resetLabel(epochSecs: number, nowMs: number): string {
  const d = new Date(epochSecs * 1000);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (epochSecs * 1000 - nowMs < 86_400_000) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

/** How old the snapshot is: `as of just now`, `as of 12 min ago`, … */
export function ageLabel(seenAt: string, nowMs: number): string {
  const t = Date.parse(seenAt);
  if (Number.isNaN(t)) return "as of an unknown time";
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return "as of just now";
  if (diff < 3_600_000) return `as of ${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `as of ${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `as of ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The newest `seenAt` across the windows (the line's age). */
export function latestSeen(ws: PlanSnapshot[]): string | null {
  let best: string | null = null;
  for (const w of ws) if (!best || Date.parse(w.seenAt) > Date.parse(best)) best = w.seenAt;
  return best;
}

/** One window in the meta line: `5h 62% · resets 19:40`, `week 31%`, or
 *  `5h reset since` once its reset time has passed. */
export function windowPhrase(w: PlanSnapshot, nowMs: number, withReset: boolean): string {
  const label = windowLabel(w.kind);
  if (hasReset(w, nowMs)) return `${label} reset since`;
  const used = w.status === "rejected" && w.utilization == null ? "limit reached" : pctLabel(w.utilization);
  const reset = withReset && w.resetsAt != null ? ` · resets ${resetLabel(w.resetsAt, nowMs)}` : "";
  return `${label} ${used}${reset}`;
}

/** The Companion line: `Claude plan · 5h 62% · resets 19:40 · week 31%`.
 *  The age is rendered beside it. Only the 5-hour and weekly windows (or
 *  the worst one, when another window is the one near its limit). */
export function planLine(ws: PlanSnapshot[], nowMs: number): string {
  const ordered = orderWindows(ws);
  const main = ordered.filter((w) => w.kind === "five_hour" || w.kind === "seven_day");
  const worst = worstWindow(ws, nowMs);
  const shown = main.length > 0 ? [...main] : ordered.slice(0, 1);
  if (worst && !shown.includes(worst) && windowTone(worst, nowMs) !== "calm") shown.push(worst);
  const parts = shown.map((w, i) => windowPhrase(w, nowMs, i === 0));
  return ["Claude plan", ...parts].join(" · ");
}

/** The calm warning near or at a limit; null while every window is calm. */
export function planWarning(ws: PlanSnapshot[], nowMs: number): string | null {
  const w = worstWindow(ws, nowMs);
  if (!w) return null;
  const tone = windowTone(w, nowMs);
  if (tone === "calm") return null;
  const reset = w.resetsAt != null ? ` — it resets at ${resetLabel(w.resetsAt, nowMs)}` : "";
  if (tone === "limited") return `Your Claude plan's ${windowName(w.kind)} is used up${reset}.`;
  const at = w.utilization != null ? `at ${pctLabel(w.utilization)}` : "near its limit";
  return `Your Claude plan's ${windowName(w.kind)} is ${at}${reset}.`;
}

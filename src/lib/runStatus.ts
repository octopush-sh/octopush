import type { Run, RunStageStatus, RunStatus } from "./ipc";

export interface StatusMeta {
  label: string;
  className: string;
}

/** Status glyph for a Direct run-track stage card. */
export function stageStatusGlyph(status: RunStageStatus | string): StatusMeta {
  switch (status) {
    case "running": return { label: "●", className: "text-octo-verdigris" };
    case "done": return { label: "✓", className: "text-octo-verdigris" };
    case "failed": return { label: "✕", className: "text-octo-rouge" };
    case "awaiting_checkpoint": return { label: "◆", className: "text-octo-brass" };
    default: return { label: "○", className: "text-octo-mute" };
  }
}

/** Status word shown beside the glyph on a stage card. */
export function stageStatusWord(status: RunStageStatus | string): string {
  switch (status) {
    case "running": return "running";
    case "done": return "done";
    case "failed": return "halted";
    case "awaiting_checkpoint": return "review";
    default: return "pending";
  }
}

export interface RunStatusMeta {
  /** Single status glyph — rendered in a row's fixed glyph slot. */
  glyph: string;
  /** Status word — rendered beside the glyph, never carrying its own glyph. */
  word: string;
  className: string;
}

export function runStatusMeta(status: RunStatus | string): RunStatusMeta {
  switch (status) {
    case "running": return { glyph: "●", word: "running", className: "text-octo-brass" };
    case "paused": return { glyph: "◆", word: "paused", className: "text-octo-brass" };
    case "completed": return { glyph: "✓", word: "done", className: "text-octo-verdigris" };
    case "aborted": return { glyph: "■", word: "aborted", className: "text-octo-mute" };
    case "failed": return { glyph: "✕", word: "failed", className: "text-octo-rouge" };
    default: return { glyph: "○", word: status, className: "text-octo-mute" };
  }
}

/** Whether a run needs the director's attention right now. `paused` always
 *  means a human must act in this engine (gate / halted stage / budget park /
 *  director pause) — the one predicate Mission Control's Needs-you band and
 *  the fleet chip (`RunsTray`) both read, so the two surfaces never disagree
 *  on what counts as "needs you". */
export function needsYou(run: Pick<Run, "status">): boolean {
  return run.status === "paused";
}

/** Whether a halted stage's error is a *transient* substrate fault (rate
 *  limit, overload, 5xx, dropped connection) — recoverable by simply waiting
 *  and resuming — versus a standing fault the work itself caused.
 *
 *  Mirrors the backend's `ProviderErrorKind::is_transient` taxonomy, read off
 *  the persisted error string (the only failure signal the row carries). The
 *  backend already auto-retries transient calls in-loop, so a stage only halts
 *  *transient* after retries are exhausted — a sustained outage, where Resume is
 *  the right affordance rather than Re-run-from-scratch or accept-partial-work. */
export function isTransientHalt(error: string | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    // Startup recovery stamps "interrupted — Octopush closed while…" on stages
    // orphaned by a crash/quit: the work isn't wrong, Resume is the affordance.
    e.startsWith("interrupted") ||
    /\brate[\s_-]?limit/.test(e) ||
    /\boverloaded\b/.test(e) ||
    // HTTP status codes, but ONLY inside our providers' "… API error <code> …"
    // framing. Matching a bare number would misread byte/line/token counts in a
    // FATAL error as transient — hiding "Accept & continue" behind "Resume".
    /api error (429|529|50[0-4])\b/.test(e) ||
    // Connection-level failures (reqwest "request failed", timeouts, DNS).
    /request failed/.test(e) ||
    /\btimed?\s?out\b|\btimeout\b/.test(e) ||
    /connection (reset|closed|refused)|dns/.test(e)
  );
}

export function savingsVsBaseline(
  costUsd: number,
  baselineUsd: number,
): { saved: number; pct: number } {
  const saved = Math.max(0, baselineUsd - costUsd);
  const pct = baselineUsd > 0 ? Math.round((saved / baselineUsd) * 100) : 0;
  return { saved, pct };
}

/** Aggregate savings across a workspace's runs: total dollars saved vs baseline
 *  and `n`, the count of runs that actually came in under baseline. The single
 *  source the Direct overview and the Companion runs ledger both read, so the
 *  two never disagree on the same workspace's figure. */
export function aggregateSavings(
  runs: { costUsd: number; baselineUsd: number }[],
): { saved: number; n: number } {
  let saved = 0;
  let n = 0;
  for (const r of runs) {
    if (r.baselineUsd > 0) {
      const s = savingsVsBaseline(r.costUsd, r.baselineUsd).saved;
      saved += s;
      if (s > 0) n += 1;
    }
  }
  return { saved, n };
}

import type { RunStageStatus, RunStatus } from "./ipc";

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

export function savingsVsBaseline(
  costUsd: number,
  baselineUsd: number,
): { saved: number; pct: number } {
  const saved = Math.max(0, baselineUsd - costUsd);
  const pct = baselineUsd > 0 ? Math.round((saved / baselineUsd) * 100) : 0;
  return { saved, pct };
}

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

export function runStatusMeta(status: RunStatus | string): StatusMeta {
  switch (status) {
    case "running": return { label: "● running", className: "text-octo-brass" };
    case "paused": return { label: "◆ paused", className: "text-octo-brass" };
    case "completed": return { label: "✓ done", className: "text-octo-verdigris" };
    case "aborted": return { label: "■ aborted", className: "text-octo-mute" };
    case "failed": return { label: "✕ failed", className: "text-octo-rouge" };
    default: return { label: status, className: "text-octo-mute" };
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

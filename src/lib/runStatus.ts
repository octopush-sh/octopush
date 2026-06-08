import type { RunStageStatus, RunStatus } from "./ipc";

export interface StatusMeta {
  label: string;
  className: string;
}

export function stageStatusMeta(status: RunStageStatus | string): StatusMeta {
  switch (status) {
    case "running": return { label: "● running", className: "text-octo-brass" };
    case "done": return { label: "✓", className: "text-octo-verdigris" };
    case "failed": return { label: "✕ failed", className: "text-octo-rouge" };
    case "awaiting_checkpoint": return { label: "◆ review", className: "text-octo-brass" };
    default: return { label: "pending", className: "text-octo-mute" };
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

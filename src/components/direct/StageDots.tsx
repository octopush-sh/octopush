import type { RunStageStatus } from "../../lib/ipc";
import { isTransientHalt, stageStatusWord } from "../../lib/runStatus";

export interface DotStage {
  status: RunStageStatus | string;
  checkpoint?: boolean;
  error?: string | null;
  /** Optional per-dot tooltip subject (role name). */
  title?: string;
}

const DOT: Record<string, string> = {
  done: "bg-octo-verdigris",
  running: "bg-octo-brass",
  awaiting_checkpoint: "bg-octo-brass",
  failed: "bg-octo-rouge",
  pending: "bg-octo-hairline",
};

/** The universal micro-track — one 5px dot per stage, the same status colour
 *  family everywhere a run is miniaturised (Companion, Mission Control cards,
 *  launcher tickets, history rows). Replaces the retired roman micro-track.
 *  Spec §4.1. */
export function StageDots({
  stages,
  className = "",
  tone = "status",
}: {
  stages: DotStage[];
  className?: string;
  /** "status" colours by run state; "shape" is the launcher-ticket neutral —
   *  every dot sage, only the gate ring carries meaning. */
  tone?: "status" | "shape";
}) {
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {stages.map((s, i) => {
        const stalled = s.status === "failed" && isTransientHalt(s.error ?? null);
        const word = stalled ? "stalled" : stageStatusWord(s.status);
        const color =
          tone === "shape" ? "bg-octo-sage" : stalled ? "bg-octo-warning" : (DOT[s.status] ?? DOT.pending);
        const title =
          tone === "shape"
            ? s.checkpoint
              ? "Pauses for your approval"
              : undefined
            : s.title
              ? `${s.title} — ${word}`
              : word;
        return (
          <span
            key={i}
            data-dot
            title={title}
            className={`h-[5px] w-[5px] shrink-0 rounded-full ${color} ${
              s.checkpoint ? "ring-1 ring-[var(--brass-dim)]" : ""
            }`}
          />
        );
      })}
    </span>
  );
}

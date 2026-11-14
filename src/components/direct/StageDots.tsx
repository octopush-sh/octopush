import type { RunStageStatus } from "../../lib/ipc";
import { isTransientHalt, stageStatusWord } from "../../lib/runStatus";

export interface DotStage {
  status: RunStageStatus | string;
  checkpoint?: boolean;
  error?: string | null;
  /** Optional per-dot tooltip subject (role name). */
  title?: string;
}

// Brass is the "needs you" mark (the gate); a running stage takes the running
// colour, verdigris, like the run track's running border — five busy crews
// must not put five brass dots on screen.
const DOT: Record<string, string> = {
  done: "bg-octo-verdigris",
  running: "bg-octo-verdigris",
  awaiting_checkpoint: "bg-octo-brass",
  failed: "bg-octo-rouge",
  pending: "bg-octo-hairline",
};

// Page-indicator tone: the page you're on is the active (brass) dot.
const PAGE: Record<string, string> = {
  seen: "bg-octo-verdigris",
  current: "bg-octo-brass",
  upcoming: "bg-octo-hairline",
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
   *  every dot sage, only the gate ring carries meaning; "pager" is a page
   *  indicator, not a run — statuses "seen" / "current" / "upcoming", and the
   *  current page is the one brass (active) dot. */
  tone?: "status" | "shape" | "pager";
}) {
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {stages.map((s, i) => {
        const stalled = s.status === "failed" && isTransientHalt(s.error ?? null);
        const word = stalled ? "stalled" : stageStatusWord(s.status);
        const color =
          tone === "shape"
            ? "bg-octo-sage"
            : tone === "pager"
              ? (PAGE[s.status] ?? PAGE.upcoming)
              : stalled
                ? "bg-octo-warning"
                : (DOT[s.status] ?? DOT.pending);
        const title =
          tone === "shape"
            ? s.checkpoint
              ? "Pauses for your approval"
              : undefined
            : tone === "pager"
              ? s.title
              : s.title
                ? `${s.title} — ${word}`
                : word;
        // The gate ring wins; otherwise a running dot carries a faint verdigris
        // halo so it still reads apart from the done dots before it.
        const ring = s.checkpoint
          ? "ring-1 ring-[var(--brass-dim)]"
          : tone === "status" && s.status === "running"
            ? "ring-1 ring-[var(--verdigris-strong)]"
            : "";
        return (
          <span
            key={i}
            data-dot
            title={title}
            className={`h-[5px] w-[5px] shrink-0 rounded-full ${color} ${ring}`}
          />
        );
      })}
    </span>
  );
}

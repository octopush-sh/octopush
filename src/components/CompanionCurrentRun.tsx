import type { RunStage } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta } from "../lib/runStatus";
import { stageTitle, fmtTokens } from "../lib/stageMeta";
import { StageDots } from "./direct/StageDots";

interface Props {
  workspaceId: string;
}

/** The active stage to spotlight: whatever needs attention, else the latest
 *  finished, else the first. */
function activeStage(stages: RunStage[]): RunStage | null {
  return (
    stages.find((s) => s.status === "running" || s.status === "awaiting_checkpoint" || s.status === "failed") ??
    [...stages].reverse().find((s) => s.status === "done") ??
    stages[0] ??
    null
  );
}

/**
 * A compact current-run summary in the Direct Companion — the piece the sidebar
 * was missing versus Talk/Run/Review. It complements (doesn't duplicate) the
 * canvas: a glanceable stage-progress strip, which stage is current, and the
 * run's cost/tokens — no live-activity stream (that's the canvas RunFlow's job).
 */
export function CompanionCurrentRun({ workspaceId }: Props) {
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const detail = useRunsStore((s) => (viewedId ? s.getDetail(viewedId) : undefined));

  const run = detail?.run;
  if (!run || !detail) return null;
  const stages = detail.stages;
  const stage = activeStage(stages);
  const meta = runStatusMeta(run.status);
  const tokIn = stages.reduce((a, s) => a + s.inputTokens, 0);
  const tokOut = stages.reduce((a, s) => a + s.outputTokens, 0);

  return (
    <div className="octo-fade-in border-b border-octo-hairline px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.3em]">
        <span className="text-octo-brass">current run</span>
        <span className={`ml-auto ${meta.className}`} title={meta.word}>{meta.glyph} {meta.word}</span>
      </div>

      {/* Glanceable stage progress — the universal micro-track. */}
      <div className="mb-2">
        <StageDots stages={stages.map((s) => ({ status: s.status, checkpoint: s.checkpoint, error: s.error, title: stageTitle(s) }))} />
      </div>

      {/* Which stage is current — fixed-height truncating slot (S1), rendered
          unconditionally so pre-hydration layout never shifts; the canvas
          RunFlow owns the live activity stream, this is a static label. */}
      <div className="mb-1.5 h-[18px] truncate font-serif text-[13px] leading-[18px] text-octo-ivory">
        {stage ? stageTitle(stage) : ""}
      </div>

      <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
        <span className="octo-tabular text-octo-brass">${run.costUsd.toFixed(2)}</span>
        {(tokIn > 0 || tokOut > 0) && (
          <span className="octo-tabular" title="input / output tokens">↑{fmtTokens(tokIn)} ↓{fmtTokens(tokOut)}</span>
        )}
      </div>
    </div>
  );
}

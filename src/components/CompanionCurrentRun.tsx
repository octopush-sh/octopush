import type { LiveEntry, RunStage } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta, stageStatusGlyph } from "../lib/runStatus";
import { stageTitle } from "../lib/stageMeta";

interface Props {
  workspaceId: string;
}

const EMPTY: LiveEntry[] = [];

/** One-line current activity from the freshest meaningful live entry. */
function lastActivity(entries: LiveEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "tool") return `§ ${e.tool}${e.hint ? " " + e.hint : ""}`;
    if (e.kind === "text") return e.text.split("\n")[0].slice(0, 70);
  }
  return "";
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
 * A live readout of the currently-viewed run in the Direct Companion — the
 * piece the sidebar was missing versus Talk/Run/Review. Shows the run's stage
 * dots, the spotlighted stage with its live activity, and cost/tokens, so the
 * director keeps run context without leaving whatever's on the canvas.
 */
export function CompanionCurrentRun({ workspaceId }: Props) {
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const detail = useRunsStore((s) => (viewedId ? s.getDetail(viewedId) : undefined));
  const stage = detail?.stages ? activeStage(detail.stages) : null;
  const entries = useRunsStore((s) => (stage ? s.liveByStage[stage.id] ?? EMPTY : EMPTY));

  const run = detail?.run;
  if (!run || !detail) return null;
  const stages = detail.stages;
  const meta = runStatusMeta(run.status);
  const tokIn = stages.reduce((a, s) => a + s.inputTokens, 0);
  const tokOut = stages.reduce((a, s) => a + s.outputTokens, 0);
  const activity = stage?.status === "running" ? lastActivity(entries) : "";

  return (
    <div className="octo-fade-in border-b border-octo-hairline px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.3em]">
        <span className="text-octo-brass">current run</span>
        <span className={`ml-auto ${meta.className}`} title={meta.word}>{meta.glyph} {meta.word}</span>
      </div>

      {/* Stage dots — done / running / blocked / pending at a glance. */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {stages.map((s) => {
          const g = stageStatusGlyph(s.status);
          const running = s.status === "running";
          return (
            <span
              key={s.id}
              title={`${stageTitle(s)} — ${s.status}`}
              className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "octo-stage-pulse bg-octo-brass" : ""} ${
                running ? "" : `border ${g.className.replace("text-", "border-")}`
              }`}
            />
          );
        })}
      </div>

      {/* Spotlight stage + live activity. */}
      {stage && (
        <div className="mb-1.5">
          <div className="truncate font-serif text-[13px] text-octo-ivory">{stageTitle(stage)}</div>
          {activity && <div className="truncate font-mono text-[10px] text-octo-brass">{activity}</div>}
        </div>
      )}

      {/* Cost + tokens. */}
      <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
        <span className="octo-tabular text-octo-brass">${run.costUsd.toFixed(2)}</span>
        {(tokIn > 0 || tokOut > 0) && (
          <span className="octo-tabular" title="input / output tokens">↑{tokIn.toLocaleString()} ↓{tokOut.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}

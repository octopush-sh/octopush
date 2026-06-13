import { useRunsStore } from "../../stores/runsStore";
import { savingsVsBaseline } from "../../lib/runStatus";

interface Props {
  workspaceId: string;
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <span className="flex items-baseline gap-1.5" title={label}>
      <span className={`octo-tabular text-[13px] ${valueClass}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-[0.2em] text-octo-mute">{label}</span>
    </span>
  );
}

/** At-a-glance Direct overview: savings to date, run count, and how many are in
 *  flight. Calm and tabular; renders nothing until the workspace has a run. */
export function DirectOverview({ workspaceId }: Props) {
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  if (runs.length === 0) return null;

  let saved = 0;
  let inFlight = 0;
  for (const r of runs) {
    if (r.baselineUsd > 0) saved += savingsVsBaseline(r.costUsd, r.baselineUsd).saved;
    if (r.status === "running" || r.status === "paused") inFlight += 1;
  }

  return (
    <div className="octo-fade-in flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono">
      <Stat label="saved" value={`$${saved.toFixed(2)}`} valueClass="text-octo-verdigris" />
      <span className="text-octo-hairline" aria-hidden="true">·</span>
      <Stat label={runs.length === 1 ? "run" : "runs"} value={String(runs.length)} valueClass="text-octo-ivory" />
      <span className="text-octo-hairline" aria-hidden="true">·</span>
      <Stat label="in flight" value={String(inFlight)} valueClass={inFlight > 0 ? "text-octo-brass" : "text-octo-mute"} />
    </div>
  );
}

import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta, savingsVsBaseline } from "../lib/runStatus";

interface Props { workspaceId: string; }

export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  const totals = runs.reduce(
    (acc, r) => {
      if (r.baselineUsd > 0) {
        acc.saved += savingsVsBaseline(r.costUsd, r.baselineUsd).saved;
        acc.n += 1;
      }
      return acc;
    },
    { saved: 0, n: 0 },
  );

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          Runs <span className="tracking-normal text-octo-mute">· {runs.length}</span>
        </span>
        <button type="button" onClick={() => selectRun(workspaceId, null)}
          className="font-serif text-[12px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
          ⟶ Begin a new run
        </button>
      </div>
      {totals.n > 0 && totals.saved > 0 && (
        <div className="px-3.5 pb-1.5 font-mono text-[10px] text-octo-mute">
          saved <span className="octo-tabular text-octo-verdigris">${totals.saved.toFixed(2)}</span> across {totals.n} run{totals.n === 1 ? "" : "s"}
        </div>
      )}
      {runs.length === 0 && (
        <div className="px-3.5 pb-3 font-serif text-[12px] text-octo-mute">No runs yet — direct your first.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
        const executing = r.status === "running" || r.status === "paused";
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRun(workspaceId, r.id)}
            className={`octo-rise-in flex w-full flex-col gap-0.5 border-l-2 px-3.5 py-2 text-left transition-colors duration-[180ms] ${
              r.id === viewedId ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-transparent hover:bg-octo-panel-2"
            }`}
          >
            <div className="truncate text-[13px] text-octo-ivory">{r.task || "(untitled run)"}</div>
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-octo-sage">
              <span className={`w-2 shrink-0 text-center ${executing ? "text-octo-brass" : "text-transparent"}`}>●</span>
              <span className={meta.className}>{meta.label}</span>
              <span className="octo-tabular">· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

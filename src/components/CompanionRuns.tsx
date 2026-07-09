import { useEffect } from "react";
import { Plus } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta, aggregateSavings } from "../lib/runStatus";
import { CompanionCurrentRun } from "./CompanionCurrentRun";

interface Props { workspaceId: string; }

export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const loaded = useRunsStore((s) => !!s.loadedByWs[workspaceId]);
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  // Ledger: total saved across runs with a baseline; n counts only the runs
  // that actually came in under baseline (shared with the Direct overview).
  const totals = aggregateSavings(runs);
  // Below half a cent the line would render "saved $0.00" — say nothing instead.
  const showLedger = totals.saved >= 0.005;

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Runs</h3>
        <button
          type="button"
          aria-label="Begin a new run"
          title="Begin a new run"
          onClick={() => selectRun(workspaceId, null)}
          className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <Plus size={12} />
        </button>
      </div>
      <CompanionCurrentRun workspaceId={workspaceId} />
      {showLedger && (
        <div className="octo-rise-in px-3.5 py-2 font-mono text-[10px] text-octo-mute">
          saved <span className="octo-tabular text-octo-verdigris">${totals.saved.toFixed(2)}</span> across {totals.n} run{totals.n === 1 ? "" : "s"}
        </div>
      )}
      {/* Empty state only once the first load has resolved — otherwise the
          panel flashes "No runs yet" while runs are still on their way. Cached
          runs render immediately and refresh silently (stale-while-revalidate). */}
      {loaded && runs.length === 0 && (
        <div className="px-3.5 py-3 font-serif text-[12px] text-octo-mute">No runs yet — direct your first.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
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
              {/* Fixed glyph slot (S1) — the one and only status glyph on the row. */}
              <span className={`w-2 shrink-0 text-center ${meta.className}`}>{meta.glyph}</span>
              <span className={meta.className}>{meta.word}</span>
              <span className="octo-tabular">· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

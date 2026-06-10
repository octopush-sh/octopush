import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta } from "../lib/runStatus";

interface Props { workspaceId: string; }

export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center justify-between px-3.5 pb-1.5 pt-2.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.13em] text-octo-brass">
          Runs <span className="text-octo-mute">· {runs.length}</span>
        </span>
        <button
          type="button"
          onClick={() => selectRun(workspaceId, null)}
          className="font-serif text-[12px] text-octo-brass hover:text-octo-ivory"
        >
          ⟶ Begin a new run
        </button>
      </div>
      {runs.length === 0 && (
        <div className="px-3.5 pb-3 font-mono text-[11px] text-octo-mute">No runs yet.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
        const executing = r.status === "running" || r.status === "paused";
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRun(workspaceId, r.id)}
            className={`flex w-full flex-col gap-0.5 border-l-2 px-3.5 py-2 text-left octo-rise-in ${
              r.id === viewedId ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-transparent hover:bg-octo-panel-2"
            }`}
          >
            <div className="truncate text-[12.5px] text-octo-ivory">{r.task || "(untitled run)"}</div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-octo-sage">
              {executing && <span className="text-octo-brass">●</span>}
              <span className={meta.className}>{meta.label}</span>
              <span>· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

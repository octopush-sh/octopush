import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta } from "../lib/runStatus";

interface Props {
  workspaceId: string;
}

export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const activeId = useRunsStore((s) => s.getActiveRunId(workspaceId));

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  return (
    <div className="border-b border-octo-hairline">
      <div className="px-3.5 pb-1.5 pt-2.5 font-mono text-[9px] uppercase tracking-[0.13em] text-octo-brass">
        Runs <span className="text-octo-mute">· {runs.length}</span>
      </div>
      {runs.length === 0 && (
        <div className="px-3.5 pb-3 font-mono text-[11px] text-octo-mute">No runs yet.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
        return (
          <div
            key={r.id}
            className={`flex flex-col gap-0.5 border-l-2 px-3.5 py-2 ${
              r.id === activeId ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-transparent"
            }`}
          >
            <div className="truncate text-[12.5px] text-octo-ivory">{r.task || "(untitled run)"}</div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-octo-sage">
              <span className={meta.className}>{meta.label}</span>
              <span>· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

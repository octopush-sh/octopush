import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity, Square } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { runStatusMeta } from "../lib/runStatus";
import { MenuSurface } from "./MenuSurface";

/** Global "Runs in progress" tray. Aggregates every active (running/paused)
 *  Direct run across ALL workspaces — since same-workspace concurrency is
 *  blocked there is ≤1 active run per workspace — into a top-bar indicator +
 *  popover. This makes Pro's parallel / background runs visible and controllable
 *  without navigating into each workspace. `onJumpToRun` switches to a run's
 *  workspace + Direct surface (mode is App-local state, so it's threaded in). */
export function RunsTray({ onJumpToRun }: { onJumpToRun: (workspaceId: string) => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const activeRuns = useRunsStore(
    useShallow((s) =>
      Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "running" || r.status === "paused"),
    ),
  );
  const workspacesByProjectId = useWorkspaceStore((s) => s.workspacesByProjectId);
  const abort = useRunsStore((s) => s.abort);

  if (activeRuns.length === 0) return null;

  // A run whose workspace isn't currently loaded (project closed/removed) still
  // shows + can be stopped — but jump-to is disabled, since we can't navigate to
  // an unloaded workspace.
  const findWs = (id: string) =>
    Object.values(workspacesByProjectId)
      .flat()
      .find((w) => w.id === id);

  const totalCost = activeRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const label = `${activeRuns.length} run${activeRuns.length > 1 ? "s" : ""} in progress · $${totalCost.toFixed(2)} combined`;

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom + 6 });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={open}
        aria-label={label}
        title={label}
        className="octo-pop-in flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition hover:bg-[var(--brass-ghost)]"
      >
        <Activity size={12} className="shrink-0" />
        {activeRuns.length} {activeRuns.length > 1 ? "runs" : "run"}
      </button>

      {anchor && (
        <MenuSurface
          x={anchor.x}
          y={anchor.y}
          ariaLabel="Runs in progress"
          onDismiss={() => setAnchor(null)}
          widthClass="w-[320px]"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
            <span>Runs in progress</span>
            <span
              className="text-octo-brass octo-tabular"
              title="Combined live cost across all active runs"
            >
              ${totalCost.toFixed(2)}
            </span>
          </div>
          {activeRuns.map((run) => {
            const meta = runStatusMeta(run.status);
            const ws = findWs(run.workspaceId);
            const rowBody = (
              <>
                <div className="flex items-center gap-1.5">
                  <span className={`shrink-0 ${meta.className}`}>{meta.glyph}</span>
                  <span className="truncate text-[12px] text-octo-ivory">{ws?.name ?? "workspace"}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-octo-brass octo-tabular">
                    ${run.costUsd.toFixed(2)}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-octo-mute">
                  {meta.word} · {run.task}
                </div>
              </>
            );
            return (
              <div
                key={run.id}
                className="group flex items-center gap-2 px-3 py-2 transition hover:bg-[var(--brass-ghost)]"
              >
                {ws ? (
                  <button
                    type="button"
                    onClick={() => {
                      onJumpToRun(run.workspaceId);
                      setAnchor(null);
                    }}
                    title="Jump to this run"
                    className="min-w-0 flex-1 text-left"
                  >
                    {rowBody}
                  </button>
                ) : (
                  <div className="min-w-0 flex-1" title="Open this run's project to view it">
                    {rowBody}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void abort(run.id).catch(console.error)}
                  aria-label="Stop run"
                  title="Stop run"
                  className="shrink-0 rounded p-1 text-octo-mute opacity-0 transition group-hover:opacity-100 hover:text-octo-rouge"
                >
                  <Square size={11} className="shrink-0" />
                </button>
              </div>
            );
          })}
        </MenuSurface>
      )}
    </>
  );
}

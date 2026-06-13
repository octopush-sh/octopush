import { useEffect, useMemo } from "react";
import { useRunsStore } from "../../stores/runsStore";
import { usePipelineStore } from "../../stores/pipelineStore";
import { RunCard } from "./RunCard";

interface Props {
  workspaceId: string;
}

const MAX_CARDS = 8;

/** Main-canvas list of a workspace's recent Direct runs — the richer sibling
 *  of CompanionRuns. Self-contained; the dashboard owns the page header and the
 *  "new run" affordance, so this renders neither. */
export function RecentRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const loaded = useRunsStore((s) => !!s.loadedByWs[workspaceId]);
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);
  const pipelines = usePipelineStore((s) => s.pipelines);

  useEffect(() => {
    void loadRuns(workspaceId);
  }, [workspaceId, loadRuns]);

  // Pipeline id → display name; a deleted pipeline resolves to null below.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pipelines) m.set(p.pipeline.id, p.pipeline.name);
    return m;
  }, [pipelines]);

  const shown = runs.slice(0, MAX_CARDS);
  const earlier = runs.length - shown.length;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        Recent Runs
      </h2>

      {/* Empty state only once the first load resolved — otherwise it flashes
          while runs are still on their way (stale-while-revalidate). */}
      {loaded && runs.length === 0 ? (
        <p className="font-serif text-[13px] text-octo-mute">
          No runs yet — direct your first.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              pipelineName={nameById.get(r.pipelineId) ?? null}
              selected={r.id === viewedId}
              onSelect={() => selectRun(workspaceId, r.id)}
            />
          ))}
          {earlier > 0 && (
            <p className="font-mono text-[10px] text-octo-mute">
              +{earlier} earlier in the Runs rail
            </p>
          )}
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { ipc, type PipelineWithStages } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { labelForRole } from "./RunTrack";

interface Props {
  defaultTask: string;
  onBegin: (pipelineId: string, task: string) => void;
}

export function PipelineSetup({ defaultTask, onBegin }: Props) {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const loaded = usePipelineStore((s) => s.loaded);
  const load = usePipelineStore((s) => s.load);
  const error = usePipelineStore((s) => s.error);

  const [task, setTask] = useState(defaultTask);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ estimateUsd: number; baselineUsd: number } | null>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => {
    if (!selectedId && pipelines.length > 0) setSelectedId(pipelines[0].pipeline.id);
  }, [pipelines, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    ipc.estimateRunCost(selectedId).then((e) => { if (!cancelled) setEstimate(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  const selected: PipelineWithStages | undefined = pipelines.find((p) => p.pipeline.id === selectedId);
  const saved = estimate ? Math.max(0, estimate.baselineUsd - estimate.estimateUsd) : 0;

  return (
    <div className="flex-1 overflow-auto px-5 py-5 octo-fade-in">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">I · Describe the work</p>
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="What should the team build?"
        className="mb-6 h-20 w-full resize-none rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2 font-mono text-sm text-octo-ivory placeholder:text-octo-mute"
      />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">II · Choose a pipeline</p>
      {loaded && pipelines.length === 0 ? (
        <div className="mb-6 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-5 text-center">
          <p className="mb-3 font-mono text-xs text-octo-rouge">
            {error ? `Couldn't load pipelines: ${error}` : "No pipelines available."}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-octo-brass px-3 py-1.5 font-mono text-xs text-octo-brass"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="mb-6 flex gap-2.5">
          {pipelines.map((p) => (
            <button
              key={p.pipeline.id}
              type="button"
              onClick={() => setSelectedId(p.pipeline.id)}
              className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
                p.pipeline.id === selectedId
                  ? "border-octo-brass bg-[var(--brass-ghost)]"
                  : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
              }`}
            >
              <h3 className="mb-1 font-serif text-[15px] text-octo-ivory">{p.pipeline.name}</h3>
              <p className="m-0 text-[11px] text-octo-sage">{p.pipeline.description}</p>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">III · Your team</p>
          <div className="mb-6 overflow-hidden rounded-lg border border-octo-hairline">
            {selected.stages.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-b border-octo-hairline bg-octo-panel-2 px-3 py-2.5 last:border-b-0">
                <span className="w-28 font-serif text-sm text-octo-ivory">{labelForRole(s.role)}</span>
                <span className="flex-1 font-mono text-xs text-octo-sage">{s.agentModel}</span>
                <span className="font-mono text-[9px] uppercase text-octo-mute">
                  {s.checkpoint ? "checkpoint" : ""}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-5 rounded-lg border border-octo-hairline bg-octo-panel-2 p-4">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-octo-mute">this pipeline</div>
              <div className="font-serif text-2xl text-octo-brass">
                ~${(estimate?.estimateUsd ?? 0).toFixed(2)}
              </div>
              {estimate && (
                <div className="font-mono text-xs text-octo-verdigris">
                  ↓ saves ~${saved.toFixed(2)} vs all-premium
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={!task.trim()}
              onClick={() => onBegin(selected.pipeline.id, task.trim())}
              className="ml-auto rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx disabled:opacity-40"
            >
              Begin the run ⟶
            </button>
          </div>
        </>
      )}
    </div>
  );
}

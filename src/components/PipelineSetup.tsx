import { useEffect, useState } from "react";
import { ipc, type PipelineWithStages } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRunsStore } from "../stores/runsStore";
import { ROMAN, stageTitle } from "./RunTrack";
import { ModelPicker } from "./ModelPicker";
import { savingsVsBaseline } from "../lib/runStatus";

interface Props {
  defaultTask: string;
  onBegin: (
    pipelineId: string,
    task: string,
    stageOverrides: [number, string][],
    budgetUsd: number | null,
  ) => void;
  executingRun: boolean;
  onEditPipeline: (pipelineId: string | null) => void;
}

/** A budget is a positive finite dollar amount; anything else means "no budget". */
function parseBudget(text: string): number | null {
  const v = Number.parseFloat(text);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function PipelineSetup({ defaultTask, onBegin, executingRun, onEditPipeline }: Props) {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const loaded = usePipelineStore((s) => s.loaded);
  const load = usePipelineStore((s) => s.load);
  const error = usePipelineStore((s) => s.error);

  const [task, setTask] = useState(defaultTask);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [budgetText, setBudgetText] = useState("");
  const [estimate, setEstimate] = useState<{ estimateUsd: number; baselineUsd: number } | null>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => {
    const exists = selectedId && pipelines.some((p) => p.pipeline.id === selectedId);
    if (!exists && pipelines.length > 0) setSelectedId(pipelines[0].pipeline.id);
  }, [pipelines, selectedId]);
  // "Run it again" (R3): consume the one-shot launcher prefill once the
  // pipeline list is in, so the existence check below is meaningful. The task
  // always applies; pipeline + crew only when that pipeline still exists.
  const consumeLauncherPrefill = useRunsStore((s) => s.consumeLauncherPrefill);
  useEffect(() => {
    if (!loaded) return;
    const prefill = consumeLauncherPrefill();
    if (!prefill) return;
    setTask(prefill.task);
    if (pipelines.some((p) => p.pipeline.id === prefill.pipelineId)) {
      setSelectedId(prefill.pipelineId);
      setOverrides(Object.fromEntries(prefill.overrides));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume exactly once, when loaded
  }, [loaded]);
  useEffect(() => {
    if (!selectedId) return;
    const tuples: [number, string][] = Object.entries(overrides)
      .map(([pos, model]) => [Number(pos), model] as [number, string]);
    let cancelled = false;
    ipc.estimateRunCost(selectedId, tuples.length > 0 ? tuples : undefined)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, overrides]);

  const selected: PipelineWithStages | undefined = pipelines.find((p) => p.pipeline.id === selectedId);
  const { saved, pct: savedPct } = estimate
    ? savingsVsBaseline(estimate.estimateUsd, estimate.baselineUsd)
    : { saved: 0, pct: 0 };

  const overrideTuples = (): [number, string][] =>
    selected
      ? selected.stages
          .filter((s) => overrides[s.position] && overrides[s.position] !== s.agentModel)
          .map((s) => [s.position, overrides[s.position]] as [number, string])
      : [];

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-6 octo-fade-in">
      {/* Ceremony */}
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct</p>
      <h1 className="m-0 mb-2 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
      <div className="animate-brass-grow mb-8 h-px bg-gradient-to-r from-octo-brass to-transparent" style={{ width: 28 }} />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">I · The brief</p>
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="What should the team build?"
        className="mb-8 h-20 w-full resize-none rounded-md border border-octo-hairline bg-octo-panel-2 px-3 py-2 font-mono text-sm text-octo-ivory transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute focus:border-[var(--brass-dim)]"
      />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">II · The pipeline</p>
      {!loaded ? (
        <div className="mb-4 flex gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="octo-fade-in h-24 flex-1 rounded-lg border border-octo-hairline bg-octo-panel-2" />
          ))}
        </div>
      ) : pipelines.length === 0 ? (
        error ? (
          <div className="mb-4 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-5 text-center">
            <p className="mb-3 font-mono text-xs text-octo-rouge">Couldn't load pipelines: {error}</p>
            <button type="button" onClick={() => void load()}
              className="rounded-md border border-octo-brass px-3 py-1.5 font-mono text-xs text-octo-brass">
              Retry
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => onEditPipeline(null)}
            className="mb-4 block w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-6 text-center font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)]">
            No pipelines yet — compose your first
          </button>
        )
      ) : (
        <div className="mb-4 flex gap-3">
          {pipelines.map((p) => (
            <div key={p.pipeline.id} className="group relative min-w-0 flex-1">
              <button
                type="button"
                onClick={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
                className={`w-full rounded-lg border p-3 text-left transition-colors duration-[180ms] ${
                  p.pipeline.id === selectedId
                    ? "border-octo-brass bg-[var(--brass-ghost)]"
                    : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
                }`}
              >
                <h3 className="mb-1 truncate pr-10 font-serif text-sm text-octo-ivory">{p.pipeline.name}</h3>
                <p className="m-0 mb-2 line-clamp-2 text-[11px] text-octo-sage">{p.pipeline.description}</p>
                <PipelineMiniMap stages={p.stages} />
              </button>
              <button
                type="button"
                onClick={() => onEditPipeline(p.pipeline.id)}
                className="absolute right-2 top-2 rounded-sm border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute opacity-0 transition-opacity duration-[180ms] hover:border-octo-hairline hover:text-octo-brass focus:opacity-100 group-hover:opacity-100"
              >
                Edit
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={() => onEditPipeline(null)}
        className="mb-8 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
        Compose a new pipeline
      </button>

      {selected && (
        <>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">III · The team</p>
          <div className="mb-8 overflow-hidden rounded-lg border border-octo-hairline">
            {selected.stages.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-b border-octo-hairline bg-octo-panel-2 px-3 py-2.5 last:border-b-0">
                <span className="w-28 shrink-0 truncate font-serif text-sm text-octo-ivory">{stageTitle(s)}</span>
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    activeModel={overrides[s.position] ?? s.agentModel}
                    onSelectModel={(m) => setOverrides((prev) => ({ ...prev, [s.position]: m }))}
                    allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
                  />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">
                  {s.checkpoint ? "⟜ gate" : ""}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-5 rounded-lg border border-octo-hairline bg-octo-panel-2 p-4">
            <div>
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">this pipeline</div>
              {estimate ? (
                <>
                  <div className="octo-tabular font-serif text-2xl text-octo-verdigris">
                    saves ~${saved.toFixed(2)}
                    <span className="ml-2 font-mono text-xs text-octo-mute">{savedPct}%</span>
                  </div>
                  <div className="octo-tabular font-mono text-xs text-octo-mute">
                    runs at <span className="text-octo-brass">~${estimate.estimateUsd.toFixed(2)}</span> · all-premium ${estimate.baselineUsd.toFixed(2)}
                  </div>
                </>
              ) : (
                <div className="h-12 font-mono text-xs text-octo-mute">estimating…</div>
              )}
            </div>
            <div className="shrink-0">
              <label
                htmlFor="run-budget"
                className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute"
              >
                budget
              </label>
              <div className="flex h-8 items-center gap-1 rounded-md border border-octo-hairline bg-octo-onyx px-2 transition-colors duration-[180ms] focus-within:border-[var(--brass-dim)]">
                <span className="font-mono text-xs text-octo-mute">$</span>
                <input
                  id="run-budget"
                  type="text"
                  inputMode="decimal"
                  value={budgetText}
                  onChange={(e) => setBudgetText(e.target.value)}
                  placeholder="no budget"
                  className="octo-tabular w-20 bg-transparent font-mono text-xs text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
                />
              </div>
            </div>
            <div className="ml-auto flex flex-col items-end gap-1.5">
              <button
                type="button"
                disabled={!task.trim() || executingRun}
                onClick={() => onBegin(selected.pipeline.id, task.trim(), overrideTuples(), parseBudget(budgetText))}
                className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
              >
                Begin the run
              </button>
              <p className="m-0 h-4 font-mono text-[10px] text-octo-mute">
                {executingRun ? "A run is in progress — finish or abort it before starting another." : ""}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PipelineMiniMap({ stages }: { stages: PipelineWithStages["stages"] }) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  return (
    <div className="truncate font-mono text-[10px]">
      {sorted.map((s, i) => (
        <span key={s.id}>
          {i > 0 && <span className="text-octo-mute"> {sorted[i - 1].checkpoint ? "⟜" : "⟶"} </span>}
          <span className="text-octo-brass/80">{ROMAN[i] ?? i + 1}</span>
        </span>
      ))}
    </div>
  );
}

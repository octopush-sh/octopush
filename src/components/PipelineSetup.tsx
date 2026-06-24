import { useEffect, useState } from "react";
import { ipc, type PipelineWithStages } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRunsStore } from "../stores/runsStore";
import { savingsVsBaseline } from "../lib/runStatus";
import { PipelineTicket } from "./direct/PipelineTicket";
import { StageFlow } from "./direct/StageFlow";
import { DirectRunsMeter } from "./DirectRunsMeter";

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

/**
 * The Direct launcher — "The Commission". One calm composition: state the brief,
 * choose an ensemble (pipeline) from a readable ticket rail, see it drawn as a
 * stage flow that doubles as the crew editor, and read the cost ledger before
 * you begin. No separate crew table, no runs gallery (runs live in the
 * Companion). Stages and tickets never collapse — they scroll.
 */
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
  // "Run it again" (R3): consume the one-shot launcher prefill once the pipeline
  // list is in, so the existence check is meaningful. The task always applies;
  // pipeline + crew only when that pipeline still exists.
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
    <div className="min-h-0 flex-1 overflow-auto px-8 py-7 octo-fade-in">
      <div className="mx-auto max-w-[940px]">
        {/* Ceremony */}
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">— direct</p>
        <h1 className="m-0 mb-2 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
        <div className="animate-brass-grow mb-9 h-px bg-gradient-to-r from-octo-brass to-transparent" style={{ width: 28 }} />

        {/* I — The brief (hero). The ⟶ glyph reads as intent entering the ensemble. */}
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">I · The brief</p>
        <div className="mb-10 flex items-start gap-3 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-3 transition-colors duration-[180ms] focus-within:border-[var(--brass-dim)]">
          <span aria-hidden="true" className="mt-1 select-none font-mono text-base text-octo-brass">⟶</span>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should the ensemble take on?"
            aria-label="The brief"
            className="h-20 w-full resize-none bg-transparent font-serif text-[16px] leading-relaxed text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
        </div>

        {/* II — The ensemble (pipeline + crew, unified). */}
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">II · The ensemble</p>
        {!loaded ? (
          <div className="mb-10 flex gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="octo-fade-in h-24 w-[184px] shrink-0 rounded-md border border-octo-hairline bg-octo-panel-2" />
            ))}
          </div>
        ) : pipelines.length === 0 ? (
          error ? (
            <div className="mb-10 rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-5 text-center">
              <p className="mb-3 font-mono text-xs text-octo-rouge">Couldn't load pipelines: {error}</p>
              <button type="button" onClick={() => void load()}
                className="rounded-md border border-octo-brass px-3 py-1.5 font-mono text-xs text-octo-brass">
                Retry
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => onEditPipeline(null)}
              className="mb-10 block w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-7 text-center font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)]">
              No ensembles yet — compose your first
            </button>
          )
        ) : (
          <div className="mb-6">
            {/* Selector rail — readable tickets that scroll, never squish. */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {pipelines.map((p) => (
                <PipelineTicket
                  key={p.pipeline.id}
                  pipeline={p}
                  selected={p.pipeline.id === selectedId}
                  onSelect={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
                  onEdit={() => onEditPipeline(p.pipeline.id)}
                />
              ))}
              {/* Compose ticket — the way into the builder. */}
              <button
                type="button"
                onClick={() => onEditPipeline(null)}
                className="flex w-[184px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-octo-hairline px-3.5 py-3 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)] hover:text-octo-brass-hi"
              >
                <span className="font-mono text-base">＋</span>
                Compose a new one
              </button>
            </div>

            {selected && (
              <div className="mt-5">
                {selected.pipeline.description && (
                  <p className="mb-3 font-serif text-[13px] text-octo-sage">{selected.pipeline.description}</p>
                )}
                <StageFlow
                  stages={selected.stages}
                  overrides={overrides}
                  onOverride={(position, model) => setOverrides((prev) => ({ ...prev, [position]: model }))}
                />
              </div>
            )}
          </div>
        )}

        {/* The ledger — savings, budget, begin. */}
        {selected && (
          <>
            <div className="my-6 h-px bg-octo-hairline" />
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
              <div className="min-w-0">
                <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">this ensemble</div>
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
                <label htmlFor="run-budget" className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
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

              <DirectRunsMeter />

              <div className="ml-auto flex flex-col items-end gap-1.5">
                <button
                  type="button"
                  disabled={!task.trim() || executingRun}
                  onClick={() => onBegin(selected.pipeline.id, task.trim(), overrideTuples(), parseBudget(budgetText))}
                  className="rounded-lg bg-octo-brass px-6 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
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
    </div>
  );
}

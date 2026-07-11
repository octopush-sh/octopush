import { useEffect, useRef, useState } from "react";
import { ipc, type PipelineWithStages } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRunsStore } from "../stores/runsStore";
import { savingsVsBaseline } from "../lib/runStatus";
import { beaconAnchor } from "../lib/beacon";
import { useEntitlement } from "../hooks/useEntitlement";
import { PipelineTicket } from "./direct/PipelineTicket";
import { StageFlow } from "./direct/StageFlow";

interface Props {
  defaultTask: string;
  linkedIssueKey?: string | null;
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

/** Tint for the runs-left fragment: sage while comfortable, amber past 80% of
 *  a cap, rouge at the cap. Uncapped stays mute. (Folded in from the retired
 *  DirectRunsMeter — the count now lives inside the ledger line.) */
function runsTone(used: number, limit: number | null): string {
  if (limit == null) return "text-octo-mute";
  if (used >= limit) return "text-octo-rouge";
  if (limit > 0 && used / limit >= 0.8) return "text-octo-warning";
  return "text-octo-sage";
}

/**
 * The Direct launcher — "The Commission". One composition surface, not a
 * wizard (the roman step framing is retired): the brief composed in serif on
 * panel, the ensemble tickets under depth-of-field optics, the crew as a
 * quiet line, and a run-grammar ledger foot. The single brass beacon (Law 2)
 * lands on "Begin the run" only when brief + ensemble + quota + concurrency
 * are all satisfied; until then the CTA is a ghost.
 */
export function PipelineSetup({ defaultTask, linkedIssueKey = null, onBegin, executingRun, onEditPipeline }: Props) {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const loaded = usePipelineStore((s) => s.loaded);
  const load = usePipelineStore((s) => s.load);
  const error = usePipelineStore((s) => s.error);
  const { usage } = useEntitlement();

  const [task, setTask] = useState(defaultTask);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [budgetText, setBudgetText] = useState("");
  const [estimate, setEstimate] = useState<{ estimateUsd: number; baselineUsd: number } | null>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => {
    const exists = selectedId && pipelines.some((p) => p.pipeline.id === selectedId);
    if (!exists && pipelines.length > 0) {
      setSelectedId(pipelines[0].pipeline.id);
      // The selection is being REPLACED (first load, or the selected pipeline
      // was deleted externally) — position-keyed overrides must not carry
      // onto a different pipeline's stages.
      setOverrides({});
    }
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
    setEstimate(null);
    const tuples: [number, string][] = Object.entries(overrides)
      .map(([pos, model]) => [Number(pos), model] as [number, string]);
    let cancelled = false;
    ipc.estimateRunCost(selectedId, tuples.length > 0 ? tuples : undefined)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, overrides]);

  const selected: PipelineWithStages | undefined = pipelines.find((p) => p.pipeline.id === selectedId);

  // Model overrides are keyed by stage POSITION. If the selected pipeline is
  // restructured under us — e.g. octopush-mcp's `update_pipeline` while the
  // window was unfocused, surfaced by the focus refresh — a kept override
  // would silently retarget onto whatever stage now sits at that position.
  // Reset overrides when the SAME selection's stage structure changes; a
  // selection change keeps its own existing semantics (incl. prefill).
  const stageSig = selected
    ? selected.stages.map((s) => `${s.position}:${s.role}`).join("|")
    : null;
  const prevSig = useRef<{ id: string | null; sig: string | null }>({ id: null, sig: null });
  useEffect(() => {
    const prev = prevSig.current;
    if (prev.id === selectedId && prev.sig !== null && stageSig !== null && prev.sig !== stageSig) {
      setOverrides({});
    }
    prevSig.current = { id: selectedId, sig: stageSig };
  }, [selectedId, stageSig]);
  const { saved, pct: savedPct } = estimate
    ? savingsVsBaseline(estimate.estimateUsd, estimate.baselineUsd)
    : { saved: 0, pct: 0 };

  const overrideTuples = (): [number, string][] =>
    selected
      ? selected.stages
          .filter((s) => overrides[s.position] && overrides[s.position] !== s.agentModel)
          .map((s) => [s.position, overrides[s.position]] as [number, string])
      : [];

  // Law 2 — the launcher is ready when brief + ensemble + concurrency + quota
  // all hold; only then does the beacon land on the CTA.
  const quotaExhausted = !!usage && usage.limit != null && usage.used >= usage.limit;
  const ready = !!selected && task.trim().length > 0 && !executingRun && !quotaExhausted;
  const beacon =
    beaconAnchor({ run: null, blockedStage: null, runningStage: null, launcherReady: ready })?.kind === "launcher";

  const beginNow = () => {
    if (!ready || !selected) return;
    onBegin(selected.pipeline.id, task.trim(), overrideTuples(), parseBudget(budgetText));
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-7 octo-fade-in">
      <div className="mx-auto max-w-[940px]">
        {/* Ceremony — serif title + one sans line. No eyebrow, no rule. */}
        <h1 className="m-0 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
        <p className="mb-7 mt-1 text-[12px] text-octo-sage">A crew of agents, your brief, one run.</p>

        {/* The brief — the noblest object: serif on panel. ⌘⏎ begins. */}
        <div className="mb-8 rounded-lg border border-octo-hairline bg-octo-panel px-4 py-3 transition-colors duration-[180ms] focus-within:border-[var(--brass-dim)]">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                beginNow();
              }
            }}
            placeholder="What should the ensemble take on?"
            aria-label="The brief"
            className="h-20 w-full resize-none bg-transparent font-serif text-[15px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
          <div className="mt-2 flex h-5 items-center gap-2">
            {linkedIssueKey && (
              <span
                className="rounded-[5px] border border-octo-hairline px-1.5 py-px font-mono text-[9px] text-octo-mute"
                title="Linked issue — attached to this run"
              >
                {linkedIssueKey}
              </span>
            )}
            <span className="ml-auto font-mono text-[9px] text-octo-mute">⌘⏎ to begin</span>
          </div>
        </div>

        {/* The ensemble. */}
        <p className="mb-3 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">ensemble</p>
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
            {/* Selector rail — depth of field: the chosen ticket at full ink,
                the rest receding (the tickets own their selected styling; the
                rail dims the unselected ones). */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {pipelines.map((p) => (
                <div
                  key={p.pipeline.id}
                  className={
                    p.pipeline.id === selectedId
                      ? undefined
                      : "opacity-[0.38] transition-opacity duration-[180ms] focus-within:opacity-70 hover:opacity-70"
                  }
                >
                  <PipelineTicket
                    pipeline={p}
                    selected={p.pipeline.id === selectedId}
                    onSelect={() => { setSelectedId(p.pipeline.id); setOverrides({}); }}
                    onEdit={() => onEditPipeline(p.pipeline.id)}
                  />
                </div>
              ))}
              {/* Compose ticket — the way into the builder. */}
              <button
                type="button"
                onClick={() => onEditPipeline(null)}
                className="flex w-[184px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-octo-hairline px-3.5 py-3 font-serif text-[13px] text-octo-brass opacity-[0.38] transition-opacity duration-[180ms] hover:opacity-100 focus-visible:opacity-100"
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
                  key={selected.pipeline.id}
                  stages={selected.stages}
                  overrides={overrides}
                  onOverride={(position, model) => setOverrides((prev) => ({ ...prev, [position]: model }))}
                />
              </div>
            )}
          </div>
        )}

        {/* The foot — the same ledger grammar as the run's strip. */}
        {selected && (
          <>
            <div className="my-6 h-px bg-octo-hairline" />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex h-5 min-w-0 items-center gap-2 font-mono text-[11px]">
                {estimate ? (
                  <>
                    <span className="octo-tabular text-octo-verdigris">est. saves ~${saved.toFixed(2)}</span>
                    <span className="octo-tabular text-octo-mute">· {savedPct}% under all-premium</span>
                    <span className="octo-tabular text-octo-mute">
                      · runs at <span className="text-octo-brass">~${estimate.estimateUsd.toFixed(2)}</span>
                    </span>
                  </>
                ) : (
                  <span className="text-octo-mute">estimating…</span>
                )}
                {usage && (
                  <span className={`octo-tabular ${runsTone(usage.used, usage.limit)}`} title="Direct runs this month">
                    · {usage.limit != null
                      ? `${Math.max(0, usage.limit - usage.used)} runs left`
                      : `${usage.used} run${usage.used === 1 ? "" : "s"} this month`}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <label htmlFor="run-budget" className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
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
                  disabled={!ready}
                  onClick={beginNow}
                  className={`rounded-lg border px-6 py-2.5 font-serif text-base transition-[color,background-color,border-color,opacity] duration-[180ms] ${
                    beacon
                      ? "octo-stage-pulse border-octo-brass bg-octo-brass text-octo-onyx hover:bg-octo-brass-hi"
                      : "border-octo-hairline bg-transparent text-octo-sage opacity-60"
                  }`}
                >
                  Begin the run
                </button>
                <p className="m-0 h-4 font-mono text-[10px] text-octo-mute">
                  {executingRun
                    ? "A run is in progress — finish or abort it before starting another."
                    : quotaExhausted
                      ? "Monthly Direct runs are used up."
                      : ""}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

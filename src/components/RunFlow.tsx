import { useEffect, useRef } from "react";
import type { LiveEntry, RunStage } from "../lib/ipc";
import { stageStatusGlyph, stageStatusWord, isTransientHalt } from "../lib/runStatus";
import { stageTitle, fmtTokens } from "../lib/stageMeta";
import { lastActivity, lastNotice } from "../lib/liveLine";
import { iconForRole } from "../lib/roleIcons";
import { shortModel } from "../lib/modelLabel";
import { useRunsStore } from "../stores/runsStore";
import { useElapsed } from "../hooks/useElapsed";
import { prefersReducedMotion } from "../lib/motion";
import { RunFlowNav } from "./RunFlowNav";

interface Props {
  stages: RunStage[];
  selectedStageId: string | null;
  /** Law 2 — the one stage allowed to pulse (beaconAnchor kind "stage"). */
  beaconStageId: string | null;
  onSelectStage: (id: string) => void;
}

const EMPTY_ENTRIES: LiveEntry[] = [];

/** The living pipeline as ONE horizontal scrolling rail, governed by the two
 *  redesign laws. Depth of field: the subject (running / awaiting / halted /
 *  selected) keeps full ink at full width; every other stage recedes to a
 *  dimmed essence card. The single beacon: only `beaconStageId` may pulse.
 *  Connectors are drawn solid lines — brass once work has flowed through,
 *  hairline ahead (gradients and the ⟶ glyph are retired); the ⟜ gate mark
 *  lives on the gated card itself. */
export function RunFlow({ stages, selectedStageId, beaconStageId, onSelectStage }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Focus follows the action: `selectedStageId` is already the shown-stage id
  // computed upstream (explicit selection, else the active stage).
  useEffect(() => {
    if (!selectedStageId) return;
    const el = cardRefs.current.get(selectedStageId);
    if (!el) return;
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [selectedStageId]);

  return (
    <div className="flex items-stretch gap-2">
      <div
        ref={railRef}
        className="octo-no-scrollbar flex min-w-0 flex-1 snap-x snap-proximity flex-nowrap items-stretch overflow-x-auto py-1 scroll-smooth"
      >
        {stages.map((s, i) => {
          const prev = stages[i - 1];
          const solid = prev && prev.status === "done";
          return (
            <div key={s.id} className="flex shrink-0 items-stretch">
              {i > 0 && (
                <span className="flex w-7 shrink-0 items-center" aria-hidden="true">
                  <span
                    className={`h-px w-full transition-colors duration-[280ms] ${
                      solid ? "bg-[var(--brass-line)]" : "bg-octo-hairline"
                    }`}
                  />
                </span>
              )}
              <div
                ref={(el) => {
                  if (el) cardRefs.current.set(s.id, el);
                  else cardRefs.current.delete(s.id);
                }}
                className="flex snap-start"
              >
                <StageCard
                  stage={s}
                  index={i}
                  stages={stages}
                  selected={s.id === selectedStageId}
                  beacon={s.id === beaconStageId}
                  onSelect={() => onSelectStage(s.id)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <RunFlowNav containerRef={railRef} stageCount={stages.length} />
    </div>
  );
}

function StageCard({
  stage: s,
  index,
  stages,
  selected,
  beacon,
  onSelect,
}: {
  stage: RunStage;
  index: number;
  stages: RunStage[];
  selected: boolean;
  beacon: boolean;
  onSelect: () => void;
}) {
  const entries = useRunsStore((st) => st.liveByStage[s.id] ?? EMPTY_ENTRIES);
  const elapsed = useElapsed(s.status === "running" ? s.startedAt : null);
  const running = s.status === "running";
  const awaiting = s.status === "awaiting_checkpoint";
  const failed = s.status === "failed";
  const transientHalt = failed && isTransientHalt(s.error);

  // Depth of field (Law 1): the subject keeps full ink; everything else
  // recedes to its essence — 38% ink, rising on hover. Nothing is removed:
  // the full detail lives in the focus pane one click away.
  const subject = running || awaiting || failed || selected;

  const base = stageStatusGlyph(s.status);
  const glyph = transientHalt ? "⟳" : base.label;
  const glyphCls = transientHalt ? "text-octo-warning" : base.className;
  const word = transientHalt ? "stalled" : stageStatusWord(s.status);
  const Icon = iconForRole(s.role);
  const cliManaged = s.substrate === "cli";

  // ONE fixed-height live/meta line on the subject; content picked by status.
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const live: { node: React.ReactNode; cls: string } = running
    ? { node: lastActivity(entries), cls: "text-octo-sage" }
    : verdict
      ? { node: verdict, cls: "text-octo-verdigris" }
      : { node: <MetaTokens stage={s} />, cls: "text-octo-mute" };

  const looping = s.loopTargetPosition !== null;
  const target = looping ? stages.find((t) => t.position === s.loopTargetPosition) : undefined;

  // Status keeps its own colour family (running verdigris, needs-you brass,
  // stall amber, hard fail rouge) — but the PULSE belongs to the beacon alone.
  const skin = transientHalt
    ? "border-[var(--warning-border)] bg-octo-panel-2 hover:border-octo-warning"
    : failed
      ? "border-[var(--rouge-border)] bg-octo-panel-2 hover:border-octo-rouge"
      : running
        ? "border-octo-verdigris bg-octo-panel-2"
        : awaiting
          ? "border-octo-brass bg-octo-panel-2"
          : selected
            ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)]"
            : "border-octo-hairline bg-octo-panel-2";

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ animationDelay: `calc(${Math.min(index, 8)} * var(--stagger-step))` }}
      className={`octo-rise-in flex shrink-0 flex-col gap-2 rounded-lg border px-3.5 py-3 text-left transition-[width,opacity,border-color,background-color,color] duration-[280ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        subject ? "w-[210px]" : "w-[150px] opacity-[0.38] hover:opacity-70 focus-visible:opacity-70"
      } ${beacon ? "octo-stage-pulse " : ""}${skin}`}
    >
      {/* Header — gate mark · role icon · title · status glyph. */}
      <div className="flex items-center gap-2">
        {s.checkpoint && (
          <span
            className="shrink-0 font-mono text-[12px] text-octo-brass"
            title="Checkpoint — pauses for your approval"
          >
            ⟜
          </span>
        )}
        <span className={subject ? "text-octo-brass" : "text-octo-sage"}>
          <Icon size={13} strokeWidth={1.75} />
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-serif text-[13px] ${subject ? "text-octo-ivory" : "text-octo-sage"}`}
          title={stageTitle(s)}
        >
          {stageTitle(s)}
        </span>
        <span key={`${s.status}-${transientHalt}`} className={`octo-pop-in font-mono text-[10px] ${glyphCls}`} title={word}>
          {glyph}
        </span>
      </div>

      {subject ? (
        <span key="subject" className="octo-fade-in flex min-w-0 flex-col gap-2">
          {/* Status word + fixed-width timer (S1/S2). */}
          <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
            <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{word}</span>
            <span className="octo-tabular ml-auto w-[5ch] shrink-0 text-right text-octo-verdigris">
              {running ? elapsed : ""}
            </span>
          </span>

          {/* Live activity / verdict / tokens — fixed height, status-picked. */}
          <span
            key={`${s.status}-live`}
            className={`octo-fade-in block h-4 truncate font-mono text-[10px] leading-4 ${live.cls}`}
          >
            {live.node}
          </span>

          {/* Meta — discreet position · model · effort · substrate pill. */}
          <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-mute">
            <span className="octo-tabular shrink-0">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.agentModel}</span>
            {s.effort && !cliManaged && (
              <span className="shrink-0 text-octo-brass" title="Reasoning effort for this stage">
                {s.effort}
              </span>
            )}
            {s.escalated && (
              <span
                className="shrink-0 text-octo-brass"
                title={`Escalated${s.escalateModel ? ` to ${s.escalateModel}` : ""} after a failed attempt`}
              >
                ↑ {s.escalateModel ? shortModel(s.escalateModel) : "retry"}
              </span>
            )}
            <span
              className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[8px] uppercase tracking-[0.18em] ${
                cliManaged
                  ? "bg-[var(--state-purple-ghost)] text-octo-state-purple"
                  : "bg-[var(--state-blue-ghost)] text-octo-state-blue"
              }`}
            >
              {s.substrate}
            </span>
          </span>

          {/* Loop badge — arabic target, no pulse (the beacon is singular). */}
          {looping && (
            <span
              className="flex h-4 items-center font-mono text-[10px] text-octo-brass"
              title={
                target
                  ? `Loops back to ${stageTitle(target)} (${s.loopIterations} of max ${s.loopMaxIterations})`
                  : `Loops back (${s.loopIterations} of max ${s.loopMaxIterations})`
              }
            >
              <span className="octo-tabular">
                ⟲ {s.loopIterations}/{s.loopMaxIterations}
              </span>
              {s.loopTargetPosition !== null && (
                <span className="ml-1">back to {s.loopTargetPosition + 1}</span>
              )}
            </span>
          )}
        </span>
      ) : (
        /* Essence meta — discreet position · cost · tokens. */
        <span key="essence" className="octo-fade-in flex h-4 items-center gap-2 font-mono text-[10px] text-octo-mute">
          <span className="octo-tabular shrink-0">{index + 1}</span>
          {(s.costUsd > 0 || s.inputTokens > 0 || s.outputTokens > 0) && <MetaTokens stage={s} />}
        </span>
      )}
    </button>
  );
}

/** Token transparency for an at-rest subject card's live line. */
function MetaTokens({ stage: s }: { stage: RunStage }) {
  const hasTokens = s.inputTokens > 0 || s.outputTokens > 0;
  return (
    <span className="flex items-center gap-2">
      <span className="octo-tabular text-octo-brass">${s.costUsd.toFixed(2)}</span>
      {hasTokens && (
        <span className="octo-tabular text-octo-mute" title="input / output tokens">
          ↑{fmtTokens(s.inputTokens)} ↓{fmtTokens(s.outputTokens)}
        </span>
      )}
    </span>
  );
}

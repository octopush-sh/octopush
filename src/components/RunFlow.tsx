import { useEffect, useRef } from "react";
import type { LiveEntry, RunStage } from "../lib/ipc";
import { stageStatusGlyph, stageStatusWord, isTransientHalt } from "../lib/runStatus";
import { ROMAN, stageTitle, fmtTokens } from "../lib/stageMeta";
import { archetypeFor } from "./builder/graph";
import { ARTIFACT_ICON } from "./builder/icons";
import { useRunsStore } from "../stores/runsStore";
import { useElapsed } from "../hooks/useElapsed";
import { prefersReducedMotion } from "../lib/motion";
import { RunFlowNav } from "./RunFlowNav";

interface Props {
  stages: RunStage[];
  selectedStageId: string | null;
  onSelectStage: (id: string) => void;
}

const EMPTY_ENTRIES: LiveEntry[] = [];

/** One-line "current activity" from the most recent meaningful live entry. */
function lastActivity(entries: LiveEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "tool") return `§ ${e.tool}${e.hint ? " " + e.hint : ""}`;
    if (e.kind === "text") return e.text.split("\n")[0].slice(0, 60);
  }
  return "";
}

/** The latest verdict notice (for a finished review), or "". */
function lastNotice(entries: LiveEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "notice") return (entries[i] as { text: string }).text;
  }
  return "";
}

/** The running pipeline drawn as a LIVING node flow — the execution-aware
 *  sibling of the launcher's StageFlow. It speaks the same node language
 *  (archetype icon, Roman numeral, substrate pill, ⟶/⟜ connectors) but each
 *  card is alive: it pulses while running, carries the live activity / elapsed
 *  time, shows token + cost transparency when at rest, and marks loop-back
 *  edges. Cards sit on ONE horizontal rail that SCROLLS (never wraps) — a
 *  7–8 stage pipeline still reads as one continuous flow instead of a
 *  saturated grid. RunFlowNav's chevrons page through overflow, and whichever
 *  stage is in focus (selected, or running/awaiting your checkpoint) scrolls
 *  into view. It supersedes the old RunTrack card strip. */
export function RunFlow({ stages, selectedStageId, onSelectStage }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Focus follows the action: `selectedStageId` is already the shown-stage id
  // computed upstream (explicit selection, else the active stage) — so simply
  // following it here covers both a manual click and a stage turning running
  // / awaiting_checkpoint.
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
          // Dim the connector until the handoff has actually completed, so a solid
          // arrow reads as "work has flowed through here". The connector leading
          // INTO the currently-running stage pulses calmly — work is flowing now.
          const solid = prev && prev.status === "done";
          const flowingHere = s.status === "running";
          return (
            <div key={s.id} className="flex shrink-0 items-stretch">
              {i > 0 && (
                <span
                  className={`flex w-7 shrink-0 items-center justify-center text-octo-brass transition-opacity duration-[280ms] ${
                    solid ? "opacity-100" : "opacity-40"
                  } ${flowingHere ? "octo-stage-pulse rounded-full" : ""}`}
                  title={prev?.checkpoint ? "Gated handoff" : "Hands off to"}
                >
                  {prev?.checkpoint ? "⟜" : "⟶"}
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
  onSelect,
}: {
  stage: RunStage;
  index: number;
  stages: RunStage[];
  selected: boolean;
  onSelect: () => void;
}) {
  const entries = useRunsStore((st) => st.liveByStage[s.id] ?? EMPTY_ENTRIES);
  const elapsed = useElapsed(s.status === "running" ? s.startedAt : null);
  const running = s.status === "running";
  const awaiting = s.status === "awaiting_checkpoint";

  // A transient halt is a recoverable caution — amber ⟳, not the rouge ✕ of a
  // hard failure. Mirrors RunTrack / the StageFocus banner.
  const transientHalt = s.status === "failed" && isTransientHalt(s.error);
  const base = stageStatusGlyph(s.status);
  const glyph = transientHalt ? "⟳" : base.label;
  const glyphCls = transientHalt ? "text-octo-warning" : base.className;
  // "stalled", not "paused": the run-level brass "◆ paused" is a deliberate
  // human gate — this amber state is an infra stall awaiting Resume.
  const word = transientHalt ? "stalled" : stageStatusWord(s.status);

  const a = archetypeFor(s.role);
  const Icon = ARTIFACT_ICON[a.artifact];
  const cliManaged = s.substrate === "cli";

  // ONE fixed-height live/meta line; content picked by status, geometry constant.
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const live: { node: React.ReactNode; cls: string } = running
    ? { node: lastActivity(entries), cls: "text-octo-sage" }
    : verdict
      ? { node: verdict, cls: "text-octo-verdigris" }
      : { node: <MetaLine stage={s} />, cls: "text-octo-mute" };

  // The loop badge marks a review that can return work to an earlier stage.
  const looping = s.loopTargetPosition !== null;
  const target = looping ? stages.find((t) => t.position === s.loopTargetPosition) : undefined;
  // The loop is "live" while the review is gating (and still has iterations
  // left) or mid-replay — pulse the badge then to signal motion in the cycle.
  const loopActive =
    looping &&
    ((awaiting && s.loopIterations < s.loopMaxIterations) || running);

  // Status carries its own colour family so the run reads at a glance and brass
  // stays surgical: running is VERDIGRIS (liveness), a checkpoint that needs you
  // is BRASS, a stall is AMBER, a hard fail is ROUGE. Selection only styles a
  // resting card (brass ghost) — an active card already announces itself, so
  // running (verdigris) never collides with selected (brass).
  const skin = transientHalt
    ? "border-[var(--warning-border)] bg-octo-panel-2 hover:border-octo-warning"
    : s.status === "failed"
      ? "border-[var(--rouge-border)] bg-octo-panel-2 hover:border-octo-rouge"
      : running
        ? "border-octo-verdigris bg-octo-panel-2"
        : awaiting
          ? "border-octo-brass bg-octo-panel-2"
          : selected
            ? "border-octo-brass bg-[var(--brass-ghost)]"
            : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]";

  // Running + awaiting both earn the calm pulse: one says "work here now", the
  // other "needs you". A resting selected card reads via the brass ghost alone.
  const pulse = (running || awaiting) ? "octo-stage-pulse " : "";

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className={`octo-rise-in flex w-[210px] shrink-0 flex-col gap-2 rounded-lg border px-3.5 py-3 text-left transition-colors ${pulse}${skin}`}
    >
      {/* Header — archetype icon · title · Roman numeral. */}
      <div className="flex items-center gap-2">
        <span className="text-octo-sage">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory" title={stageTitle(s)}>
          {stageTitle(s)}
        </span>
        <span className="font-mono text-[11px] text-octo-brass">{ROMAN[index] ?? index + 1}</span>
      </div>

      {/* Status row — glyph · word · elapsed (running only). */}
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <span key={`${s.status}-${transientHalt}`} className={`octo-pop-in ${glyphCls}`} title={word}>
          {glyph}
        </span>
        <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{word}</span>
        <span className="octo-tabular ml-auto w-[5ch] shrink-0 text-right text-octo-verdigris">
          {running ? elapsed : ""}
        </span>
      </span>

      {/* Model · substrate pill. */}
      <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-mute">
        <span className="min-w-0 flex-1 truncate">{s.agentModel}</span>
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

      {/* Live activity / verdict / cost+tokens — fixed height, status-picked. */}
      <span
        key={`${s.status}-live`}
        className={`octo-fade-in block h-4 truncate font-mono text-[10px] leading-4 ${live.cls}`}
      >
        {live.node}
      </span>

      {/* Loop badge — pulses while the cycle is live. */}
      {looping && (
        <span
          className={`flex h-4 items-center font-mono text-[10px] text-octo-brass ${loopActive ? "octo-stage-pulse rounded-sm" : ""}`}
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
            // "back to" — the loop hands work to an EARLIER stage; a plain → read
            // as forward flow, contradicting the ⟶ connectors on the same card.
            <span className="ml-1">back to {ROMAN[s.loopTargetPosition] ?? s.loopTargetPosition + 1}</span>
          )}
        </span>
      )}
    </button>
  );
}

/** Cost + token transparency for an at-rest stage. Cost in brass (the only
 *  quirurgical brass here), tokens quiet in mute, both tabular. */
function MetaLine({ stage: s }: { stage: RunStage }) {
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

import { useState } from "react";
import type { LiveEntry, Run, RunStage } from "../lib/ipc";
import { stageStatusGlyph, stageStatusWord, isTransientHalt } from "../lib/runStatus";
import { useRunsStore } from "../stores/runsStore";
import { useElapsed } from "../hooks/useElapsed";
import { Reveal } from "./primitives/Reveal";

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

interface Props {
  run: Run;
  stages: RunStage[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  /** Stop the in-flight stage (shown only while the run is `running`). */
  onStopStage?: () => void;
  /** Abort the whole run (shown only while the run is `running`). */
  onAbort?: () => void;
  /** Re-run this pipeline: seed the launcher from this run (terminal runs only). */
  onRunAgain?: () => void;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "aborted", "failed"]);

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
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "notice") return (entries[i] as { text: string }).text;
  return "";
}

export function RunTrack({ run, stages, selectedStageId, onSelectStage, onStopStage, onAbort, onRunAgain }: Props) {
  const doneCount = stages.filter((s) => s.status === "done").length;
  const [briefOpen, setBriefOpen] = useState(false);

  return (
    <div className="border-b border-octo-hairline bg-octo-panel px-4 py-3">
      <div className="octo-fade-in mb-3 flex items-start gap-6">
        <div className="shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">stage</div>
          <div className="octo-tabular font-mono text-sm text-octo-ivory">
            {Math.min(doneCount + 1, stages.length)} / {stages.length}
          </div>
        </div>
        <button
          type="button"
          aria-label="Toggle the full brief"
          aria-expanded={briefOpen}
          title={run.task}
          onClick={() => setBriefOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">the brief</span>
          <span className="block min-w-0 truncate font-serif text-[13px] leading-5 text-octo-ivory">
            {run.task}
          </span>
        </button>
        {/* S1: the control slot is always reserved so buttons appearing or
            leaving never shift the header geometry. */}
        <div className="flex h-9 w-[190px] shrink-0 items-center justify-end gap-2 self-center">
          {run.status === "running" && (
            <span key="running-controls" className="octo-fade-in flex items-center gap-2">
              <button
                type="button"
                onClick={onStopStage}
                className="rounded-md border border-octo-hairline px-2.5 py-1 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory"
              >
                Stop the stage
              </button>
              <button
                type="button"
                onClick={onAbort}
                className="rounded-md border border-transparent px-2.5 py-1 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge"
              >
                Abort
              </button>
            </span>
          )}
          {TERMINAL_RUN_STATUSES.has(run.status) && onRunAgain && (
            <button
              key="run-again"
              type="button"
              onClick={onRunAgain}
              className="octo-fade-in font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory"
            >
              Run it again
            </button>
          )}
        </div>
      </div>
      <Reveal open={briefOpen}>
        <p
          data-testid="brief-full"
          className="m-0 mb-3 select-text whitespace-pre-wrap font-serif text-[13px] leading-relaxed text-octo-sage"
        >
          {run.task}
        </p>
      </Reveal>
      <div className="flex items-stretch overflow-x-auto pb-1">
        {stages.map((s, i) => (
          <div key={s.id} className="flex min-w-0 items-stretch">
            {i > 0 && (
              <div
                className={`flex w-6 shrink-0 items-center justify-center text-octo-brass transition-opacity duration-[280ms] ${
                  stages[i - 1].status === "done" ? "opacity-100" : "opacity-40"
                }`}
              >
                {stages[i - 1].checkpoint ? "⟜" : "⟶"}
              </div>
            )}
            <StageCard stage={s} index={i} selected={s.id === selectedStageId} onSelect={() => onSelectStage(s.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StageCard({ stage: s, index, selected, onSelect }: {
  stage: RunStage; index: number; selected: boolean; onSelect: () => void;
}) {
  const entries = useRunsStore((st) => st.liveByStage[s.id] ?? EMPTY_ENTRIES);
  const elapsed = useElapsed(s.status === "running" ? s.startedAt : null);
  const running = s.status === "running";
  // A transient halt is a recoverable caution — amber ⟳, not the rouge ✕ of a
  // hard failure. Mirrors the StageFocus banner and CheckpointBar treatment.
  const transientHalt = s.status === "failed" && isTransientHalt(s.error);
  const base = stageStatusGlyph(s.status);
  const glyph = transientHalt ? "⟳" : base.label;
  const cls = transientHalt ? "text-octo-warning" : base.className;
  // "stalled", not "paused": the run-level brass "◆ paused" is a deliberate
  // human checkpoint gate — this amber state is an infra stall awaiting Resume.
  const word = transientHalt ? "stalled" : stageStatusWord(s.status);

  // S1: ONE fixed-height live line; content picked by status, geometry constant.
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const live = running
    ? { text: lastActivity(entries), cls: "text-octo-brass", tabular: false }
    : verdict
      ? { text: verdict, cls: "text-octo-verdigris", tabular: false }
      : { text: `$${s.costUsd.toFixed(2)}`, cls: "text-octo-mute", tabular: true };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`octo-rise-in flex h-[96px] min-w-[170px] max-w-[230px] flex-1 basis-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
        running ? "octo-stage-pulse " : ""
      }${
        selected
          ? "border-octo-brass bg-[var(--brass-ghost)]"
          : transientHalt
            ? "border-[var(--warning-border)] bg-octo-panel-2 hover:border-octo-warning"
            : s.status === "failed"
              ? "border-[var(--rouge-border)] bg-octo-panel-2 hover:border-octo-rouge"
              : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
      }`}
    >
      <span className="flex h-4 items-center gap-1.5 font-mono text-[10px]">
        <span className="text-octo-brass">{ROMAN[index] ?? index + 1}</span>
        <span key={`${s.status}-${transientHalt}`} className={`octo-pop-in ${cls}`}>{glyph}</span>
        <span className="truncate uppercase tracking-[0.25em] text-octo-mute">{word}</span>
        <span className="octo-tabular ml-auto w-[5ch] shrink-0 text-right text-octo-brass">{running ? elapsed : ""}</span>
      </span>
      <span className="h-5 truncate font-serif text-sm leading-5 text-octo-ivory">{stageTitle(s)}</span>
      <span className="flex h-4 items-center gap-2 font-mono text-[10px] text-octo-sage">
        <span className="truncate">{s.agentModel}</span>
        <SubstratePill substrate={s.substrate} />
      </span>
      <span
        key={`${s.status}-live`}
        className={`octo-fade-in mt-auto block h-4 truncate font-mono text-[10px] leading-4 ${live.cls} ${live.tabular ? "octo-tabular" : ""}`}
      >
        {live.text}
      </span>
    </button>
  );
}

function SubstratePill({ substrate }: { substrate: string }) {
  const cls =
    substrate === "cli"
      ? "text-octo-state-purple border-[var(--state-purple-dim)]"
      : "text-octo-state-blue border-[var(--state-blue-dim)]";
  return (
    <span className={`flex w-9 shrink-0 items-center justify-center rounded-sm border py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] ${cls}`}>
      {substrate}
    </span>
  );
}

/** The stage's display title: the author's custom name when set, else the
 *  archetype label. Keeps the run view in step with names chosen in the builder. */
export function stageTitle(s: { role: string; customName?: string | null }): string {
  const custom = s.customName?.trim();
  return custom && custom.length > 0 ? custom : labelForRole(s.role);
}

export function labelForRole(role: string): string {
  const map: Record<string, string> = {
    plan: "Plan",
    plan_review: "Plan review",
    implement: "Implement",
    code_review: "Code review",
    test: "Tests",
    repro: "Reproduce",
    fix: "Fix",
    verify: "Verify",
    critique: "Critique",
    refine: "Refine",
  };
  return map[role] ?? role;
}

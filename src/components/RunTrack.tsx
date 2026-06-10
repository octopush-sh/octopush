import type { LiveEntry, Run, RunStage } from "../lib/ipc";
import { stageStatusMeta } from "../lib/runStatus";
import { useRunsStore } from "../stores/runsStore";
import { useElapsed } from "../hooks/useElapsed";

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

interface Props {
  run: Run;
  stages: RunStage[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
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
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "notice") return (entries[i] as { text: string }).text;
  return "";
}

export function RunTrack({ run: _run, stages, selectedStageId, onSelectStage }: Props) {
  const doneCount = stages.filter((s) => s.status === "done").length;

  return (
    <div className="border-b border-octo-hairline bg-octo-panel px-4 py-3">
      <div className="mb-3 flex items-baseline gap-6 font-mono text-xs octo-fade-in">
        <Meta label="stage" value={`${Math.min(doneCount + 1, stages.length)} / ${stages.length}`} valueClass="text-octo-ivory" />
      </div>
      <div className="flex items-stretch">
        {stages.map((s, i) => (
          <div key={s.id} className="flex items-stretch min-w-0">
            {i > 0 && (
              <div className="flex w-6 items-center justify-center text-octo-brass">
                {stages[i - 1].checkpoint ? "⟜" : "⟶"}
              </div>
            )}
            <StageCard
              stage={s}
              index={i}
              selected={s.id === selectedStageId}
              onSelect={() => onSelectStage(s.id)}
            />
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
  const activity = running ? lastActivity(entries) : "";
  const verdict = s.status === "done" ? lastNotice(entries) : "";
  const meta = stageStatusMeta(s.status);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors octo-rise-in ${
        running ? "octo-stage-pulse " : ""
      }${selected ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"}`}
    >
      {running && elapsed && (
        <span className="absolute right-3 top-2 font-mono text-[10px] text-octo-brass">{elapsed}</span>
      )}
      <span className="font-mono text-[10px] text-octo-brass">
        {ROMAN[index] ?? index + 1} <span className={meta.className}>{meta.label}</span>
      </span>
      <span className="font-serif text-sm text-octo-ivory">{labelForRole(s.role)}</span>
      <span className="flex items-center gap-2 font-mono text-[9px] text-octo-sage">
        {s.agentModel}
        <SubstratePill substrate={s.substrate} />
      </span>
      {running && activity ? (
        <span className="mt-auto truncate font-mono text-[10px] text-octo-brass">{activity}</span>
      ) : verdict ? (
        <span className="mt-auto truncate font-mono text-[10px] text-octo-verdigris">{verdict}</span>
      ) : (
        <span className="mt-auto font-mono text-[10px] text-octo-mute">${s.costUsd.toFixed(2)}</span>
      )}
    </button>
  );
}

function Meta({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.14em] text-octo-mute">{label}</div>
      <div className={`text-sm ${valueClass}`}>{value}</div>
    </div>
  );
}

function SubstratePill({ substrate }: { substrate: string }) {
  const cls =
    substrate === "cli"
      ? "text-octo-state-purple border-octo-state-purple"
      : "text-octo-state-blue border-octo-state-blue";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[8px] uppercase ${cls}`}>
      {substrate}
    </span>
  );
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

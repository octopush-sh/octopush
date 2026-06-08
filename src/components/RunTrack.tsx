import type { Run, RunStage } from "../lib/ipc";
import { stageStatusMeta } from "../lib/runStatus";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

interface Props {
  run: Run;
  stages: RunStage[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
}

export function RunTrack({ run, stages, selectedStageId, onSelectStage }: Props) {
  const saved = Math.max(0, run.baselineUsd - run.costUsd);
  const doneCount = stages.filter((s) => s.status === "done").length;

  return (
    <div className="border-b border-octo-hairline bg-octo-panel px-4 py-3">
      <div className="mb-3 flex items-baseline gap-6 font-mono text-xs octo-fade-in">
        <Meta label="spent" value={`$${run.costUsd.toFixed(2)}`} valueClass="text-octo-brass" />
        <Meta label="saved vs all-premium" value={`+$${saved.toFixed(2)}`} valueClass="text-octo-verdigris" />
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
            <button
              type="button"
              onClick={() => onSelectStage(s.id)}
              className={`flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors octo-rise-in ${
                s.id === selectedStageId
                  ? "border-octo-brass bg-[var(--brass-ghost)]"
                  : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
              }`}
            >
              <span className="font-mono text-[10px] text-octo-brass">
                {ROMAN[i] ?? i + 1}{" "}
                <span className={stageStatusMeta(s.status).className}>
                  {stageStatusMeta(s.status).label}
                </span>
              </span>
              <span className="font-serif text-sm text-octo-ivory">{labelForRole(s.role)}</span>
              <span className="flex items-center gap-2 font-mono text-[9px] text-octo-sage">
                {s.agentModel}
                <SubstratePill substrate={s.substrate} />
              </span>
              <span className="mt-auto font-mono text-[10px] text-octo-mute">
                ${s.costUsd.toFixed(2)}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
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

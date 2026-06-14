import { useEffect, useRef, useState } from "react";
import type { Run, RunStage } from "../lib/ipc";
import { savingsVsBaseline } from "../lib/runStatus";
import { labelForRole, fmtTokens } from "../lib/stageMeta";
import { Reveal } from "./primitives/Reveal";

interface Props {
  run: Run;
  stages: RunStage[];
}

/** The ledger strip — Direct's cost surface, savings-first (the differentiator
 *  leads). Single calm line + 2px progress inset; click to unfold the per-stage
 *  breakdown. On run completion, a one-shot brass sweep + serif phrase. */
export function RunLedger({ run, stages }: Props) {
  const { saved, pct } = savingsVsBaseline(run.costUsd, run.baselineUsd);
  const fillPct = run.baselineUsd > 0 ? Math.min(100, (run.costUsd / run.baselineUsd) * 100) : 0;
  const tokIn = stages.reduce((a, s) => a + s.inputTokens, 0);
  const tokOut = stages.reduce((a, s) => a + s.outputTokens, 0);
  const [expanded, setExpanded] = useState(false);
  const [moment, setMoment] = useState(false);
  const prevStatus = useRef(run.status);

  useEffect(() => {
    setMoment(false);
    setExpanded(false);
    prevStatus.current = run.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  useEffect(() => {
    if (prevStatus.current !== "completed" && run.status === "completed" && run.baselineUsd > 0) {
      setMoment(true);
    }
    prevStatus.current = run.status;
  }, [run.status, run.baselineUsd]);

  const billed = stages.filter((s) => s.costUsd > 0);

  return (
    <div className="border-t border-octo-hairline bg-octo-panel">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left font-mono text-[11px]"
      >
        <span className="text-octo-mute">saved</span>
        {run.baselineUsd > 0 ? (
          <>
            <span className="octo-tabular text-octo-verdigris">${saved.toFixed(2)}</span>
            <span className="octo-tabular text-octo-mute">· {pct}% under all-premium</span>
          </>
        ) : (
          <span className="text-octo-mute">baseline unavailable</span>
        )}
        <span className="ml-auto text-octo-mute">spent</span>
        <span className="octo-tabular text-octo-brass">${run.costUsd.toFixed(2)}</span>
        {run.budgetUsd != null && (
          <span
            className={`octo-tabular ${
              run.costUsd >= run.budgetUsd ? "text-octo-rouge" : "text-octo-mute"
            }`}
          >
            · budget ${run.budgetUsd.toFixed(2)}
          </span>
        )}
        {(tokIn > 0 || tokOut > 0) && (
          <span className="octo-tabular text-octo-mute" title="input / output tokens">
            · ↑{fmtTokens(tokIn)} ↓{fmtTokens(tokOut)}
          </span>
        )}
        <span className="font-mono text-[9px] text-octo-mute">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="mx-4 h-0.5 overflow-hidden rounded-sm bg-octo-onyx">
        <div
          className="h-full rounded-sm bg-octo-brass transition-[width] duration-[280ms]"
          style={{ width: `${fillPct}%`, transitionTimingFunction: "var(--ease-octo)" }}
        />
      </div>
      <Reveal open={expanded}>
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 font-mono text-[10px] text-octo-mute">
          {billed.map((s) => (
            <span key={s.id}>
              {labelForRole(s.role)} <span className="octo-tabular text-octo-sage">${s.costUsd.toFixed(2)}</span>
              {(s.inputTokens > 0 || s.outputTokens > 0) && (
                <span className="octo-tabular text-octo-mute"> · ↑{fmtTokens(s.inputTokens)} ↓{fmtTokens(s.outputTokens)}</span>
              )}
            </span>
          ))}
          {billed.length === 0 && <span>no billed stages yet</span>}
        </div>
      </Reveal>
      <Reveal open={moment}>
        <div className="px-4 pb-3 pt-2">
          <div className="octo-sweep mb-2 h-px bg-gradient-to-r from-octo-brass to-transparent" />
          <p className="m-0 font-serif text-sm text-octo-ivory">
            This run saved <span className="octo-tabular text-octo-verdigris">${saved.toFixed(2)}</span> against the all-premium baseline.
          </p>
        </div>
      </Reveal>
      <div className="pb-1.5" />
    </div>
  );
}

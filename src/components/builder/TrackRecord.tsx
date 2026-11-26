import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { CrewSuggestion, StageDraft, StageOutcome } from "../../lib/ipc";
import { recentDots, suggestionCta, suggestionDetail, suggestionPatch, trackRecordLine, trackRecordTitle } from "../../lib/crewReport";
import { StageDots } from "../direct/StageDots";
import { Reveal } from "../primitives/Reveal";

export interface StageRecord {
  /** `null` until this stage, as it is now, has runs. */
  outcome: StageOutcome | null;
  minRuns: number;
  suggestions: CrewSuggestion[];
  name: string;
  /** A loop hotspot's sender, by position. */
  senderName: (position: number | null) => string;
}

/** The stage inspector's Track record (#983): this Mac's latest runs of the
 *  stage, a 10-outcome micro-history, and the suggestions they support. A
 *  suggestion edits the draft like any other change: it is kept only when
 *  the pipeline is saved, and undo takes it back. */
export function TrackRecord({ record, onPatch }: { record: StageRecord; onPatch: (p: Partial<Pick<StageDraft, "agentModel" | "escalateModel">>) => void }) {
  const { outcome, minRuns, suggestions, name, senderName } = record;
  const [open, setOpen] = useState(suggestions.length > 0);
  const ready = outcome != null && outcome.runs >= minRuns;

  return (
    <div className="flex flex-col gap-2 border-t border-octo-hairline pt-4" data-tour="builder-stage-track-record">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="How this stage did in this Mac's latest runs of this crew."
        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute transition-colors duration-[150ms] hover:text-octo-sage"
      >
        <ChevronRight size={11} strokeWidth={1.75} className={`transition-transform duration-[220ms] ${open ? "rotate-90" : ""}`} />
        Track record
      </button>
      <Reveal open={open}>
        {ready ? (
          <div className="flex flex-col gap-2">
            <p title={trackRecordTitle(outcome)} className="octo-tabular m-0 cursor-default font-mono text-[10px] leading-relaxed text-octo-sage">
              {trackRecordLine(outcome)}
            </p>
            <StageDots tone="outcome" stages={recentDots(outcome)} />
            {suggestions.map((s) => {
              const patch = suggestionPatch(s);
              return (
                <div key={s.kind} className="flex flex-col gap-1">
                  <p className="m-0 text-[11px] leading-[1.5] text-octo-sage">{suggestionDetail(s, name, senderName(s.senderPosition))}</p>
                  {patch && (
                    <button
                      type="button"
                      onClick={() => onPatch(patch)}
                      title="Changes this stage in the draft. Save the pipeline to keep it; undo takes it back."
                      className="self-start font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80"
                    >
                      {suggestionCta(s, name)}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="m-0 text-[11px] text-octo-mute">Track record appears after {minRuns} runs of this crew.</p>
        )}
      </Reveal>
    </div>
  );
}

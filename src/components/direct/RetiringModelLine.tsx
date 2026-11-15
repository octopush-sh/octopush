import { useState } from "react";
import type { PipelineWithStages } from "../../lib/ipc";
import { crewModels, crewRetirements, retirementLine } from "../../lib/modelRetirement";
import { switchedDraft } from "../../lib/supersededModels";
import { useModelRetirements } from "../../hooks/useModelRetirements";
import { usePipelineStore } from "../../stores/pipelineStore";
import { pushToast } from "../Toasts";

interface Props {
  pipeline: PipelineWithStages;
  /** The launcher's per-run model picks, by stage position. */
  overrides: Record<number, string>;
  /** The saved pipeline's id — a builtin's switch forks it into a new one. */
  onSwitched: (pipelineId: string, fromIds: string[], toId: string) => void;
}

/** The launcher foot's line for a crew on a model with a published retirement
 *  date: amber in its last 30 days, rouge after. "Switch to Sonnet 5.5" asks
 *  first, then edits only this crew; it never runs on its own. */
export function RetiringModelLine({ pipeline, overrides, onSwitched }: Props) {
  const table = useModelRetirements(crewModels(pipeline.stages, overrides));
  const save = usePipelineStore((s) => s.save);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const now = new Date();
  const notice = crewRetirements(pipeline.stages, table, now, overrides)[0];
  if (!notice) return null;
  const { retirement, phase, ids, stages } = notice;
  // Only the saved crew is switched; a launcher pick alone is changed there.
  const savedIds = ids.filter((id) => crewModels(pipeline.stages).includes(id));
  const subject = stages === 1 ? "a stage on it" : `${stages} stages on it`;
  const retired = phase.kind === "retired";

  const switchCrew = async () => {
    setSaving(true);
    try {
      const id = await save(switchedDraft(pipeline, savedIds, retirement.replacement));
      onSwitched(id, ids, retirement.replacement);
      setConfirming(false);
    } catch (e) {
      pushToast({
        level: "error",
        title: "Couldn't switch this crew",
        body: (e instanceof Error ? e.message : String(e)).replace(/^other: /, ""),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-tour="direct-launcher-model-retirement"
      data-testid="launcher-model-retirement"
      data-phase={phase.kind}
      className="octo-rise-in mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <span
        title="The provider refuses requests to a model after its retirement date. The run can still begin."
        className={`octo-tabular font-mono text-[11px] ${retired ? "text-octo-rouge" : "text-octo-warning"}`}
      >
        {confirming
          ? `Every stage of this crew on ${retirement.label}, escalations included, moves to ${retirement.replacementLabel}.`
          : retirementLine(retirement, phase, now, subject)}
      </span>
      {savedIds.length > 0 && (
        <span key={confirming ? "confirm" : "offer"} className="octo-fade-in ml-auto flex shrink-0 items-baseline gap-3">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => void switchCrew()}
                title="Saves this crew. You can change it back in the builder."
                className="font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80 disabled:opacity-50"
              >
                Switch this crew
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setConfirming(false)}
                className="font-serif text-[12px] text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage disabled:opacity-50"
              >
                Not now
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              title={`Move this crew from ${retirement.label} to ${retirement.replacementLabel}. You confirm first.`}
              className="font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80"
            >
              Switch to {retirement.replacementLabel}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

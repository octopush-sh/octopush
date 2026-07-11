import { Pencil } from "lucide-react";
import type { PipelineWithStages } from "../../lib/ipc";
import { StageDots } from "./StageDots";

interface Props {
  pipeline: PipelineWithStages;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

/** A compact, always-readable pipeline ticket in the launcher's selector rail.
 *  The name never collapses (fixed min-width, graceful truncate); the shape line
 *  hints at the flow; an `&` brass seal marks an Octopush original. The full
 *  description lives by the selected pipeline's flow, not crammed in here. */
export function PipelineTicket({ pipeline, selected, onSelect, onEdit }: Props) {
  const { name, isBuiltin } = pipeline.pipeline;
  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={name}
        className={`flex w-[184px] flex-col gap-2 rounded-md border px-3.5 py-3 text-left transition-colors duration-[180ms] ${
          selected
            ? "border-octo-brass bg-[var(--brass-ghost)]"
            : "border-octo-hairline bg-octo-panel-2 hover:border-[var(--brass-dim)]"
        }`}
      >
        <div className="flex items-center gap-1.5">
          {isBuiltin && (
            <span className="font-serif text-[13px] leading-none text-octo-brass" title="An Octopush original">
              &amp;
            </span>
          )}
          <span className="min-w-0 flex-1 truncate pr-6 font-serif text-[14px] text-octo-ivory">{name}</span>
        </div>
        {/* Shape line — the universal micro-track in its neutral tone; the dot
            run clips while the stage count always stays legible. */}
        <div className="flex items-center gap-1 font-mono text-[10px] text-octo-mute">
          <StageDots
            tone="shape"
            stages={stages.map((s) => ({ status: "pending", checkpoint: s.checkpoint }))}
            className="min-w-0 flex-1 overflow-hidden"
          />
          <span className="ml-1 shrink-0 whitespace-nowrap">{stages.length} {stages.length === 1 ? "stage" : "stages"}</span>
        </div>
      </button>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        title="Edit pipeline"
        className="absolute right-2 top-2 flex items-center justify-center rounded p-1 text-octo-mute opacity-0 transition-opacity duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass group-hover:opacity-100"
      >
        <Pencil size={11} strokeWidth={1.75} />
      </button>
    </div>
  );
}

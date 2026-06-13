import type { PipelineWithStages } from "../../lib/ipc";

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
            <span className="font-serif text-[13px] italic leading-none text-octo-brass" title="An Octopush original">
              &amp;
            </span>
          )}
          <span className="min-w-0 flex-1 truncate pr-6 font-serif text-[14px] text-octo-ivory">{name}</span>
        </div>
        {/* Shape line: a dot per stage, brass connectors (⟜ after a gate). */}
        <div className="flex items-center gap-1 font-mono text-[10px] text-octo-mute">
          {stages.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-octo-brass/70">{stages[i - 1].checkpoint ? "⟜" : "⟶"}</span>}
              <span className="inline-block h-1 w-1 rounded-full bg-octo-sage" />
            </span>
          ))}
          <span className="ml-1 whitespace-nowrap">{stages.length} {stages.length === 1 ? "stage" : "stages"}</span>
        </div>
      </button>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        title="Edit pipeline"
        className="absolute right-2 top-2 rounded-sm border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute opacity-0 transition-opacity duration-[180ms] hover:border-octo-hairline hover:text-octo-brass focus:opacity-100 group-hover:opacity-100"
      >
        Edit
      </button>
    </div>
  );
}

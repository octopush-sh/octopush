import { FileText, Eye, Code2, FlaskConical, StickyNote } from "lucide-react";
import { ARCHETYPES, type ArtifactKind } from "./graph";

const ARTIFACT_ICON: Record<ArtifactKind, typeof FileText> = {
  plan: FileText,
  review: Eye,
  diff: Code2,
  tests: FlaskConical,
  note: StickyNote,
};

export const ARCHETYPE_DND_MIME = "application/octopush-archetype";

interface Props {
  /** Click-to-add fallback (drag-and-drop is the primary gesture). */
  onAdd: (role: string) => void;
}

/** The well of stage archetypes. Drag one onto the canvas, or click to drop it
 *  at the center. Each carries an icon + a tooltip describing its contract. */
export function NodePalette({ onAdd }: Props) {
  return (
    <div className="octo-fade-in flex w-[176px] flex-col gap-1 rounded-lg border border-octo-hairline bg-octo-panel/95 p-2 backdrop-blur-sm">
      <p className="px-1 pb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">Stages</p>
      <div className="flex max-h-[52vh] flex-col gap-0.5 overflow-y-auto">
        {ARCHETYPES.map((a) => {
          const Icon = ARTIFACT_ICON[a.artifact];
          return (
            <button
              key={a.role}
              type="button"
              title={a.description}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ARCHETYPE_DND_MIME, a.role);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd(a.role)}
              className="group flex cursor-grab items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-[150ms] hover:bg-[var(--brass-ghost)] active:cursor-grabbing"
            >
              <span className="text-octo-sage transition-colors duration-[150ms] group-hover:text-octo-brass">
                <Icon size={13} strokeWidth={1.75} />
              </span>
              <span className="font-serif text-[13px] text-octo-ivory">{a.label}</span>
              {a.canLoop && (
                <span className="ml-auto font-mono text-[9px] text-octo-mute" title="Can loop work back">
                  ⟜
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

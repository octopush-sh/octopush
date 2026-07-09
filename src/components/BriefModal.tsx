import { Copy } from "lucide-react";
import { copyToClipboard } from "../lib/clipboard";
import { ModalShell } from "./ModalShell";

interface Props {
  task: string;
  pipelineName: string;
  stageCount: number;
  onClose: () => void;
}

/** The full run brief in a proper dialog. Long multi-paragraph tasks used to
 *  surface via a native `title` tooltip, which renders as a giant unstyled
 *  blob for anything past a sentence — this replaces it with the canonical
 *  ModalShell: scrollable, copyable, on-brand. */
export function BriefModal({ task, pipelineName, stageCount, onClose }: Props) {
  return (
    <ModalShell onClose={onClose} ariaLabel="The brief" panelClassName="w-[640px] max-w-[92vw]">
      <div className="flex max-h-[72vh] flex-col overflow-hidden rounded-lg border border-octo-hairline bg-octo-panel">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline px-4">
          <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">The brief</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-octo-mute">
            {pipelineName} · {stageCount} {stageCount === 1 ? "stage" : "stages"}
          </span>
          <button
            type="button"
            aria-label="Copy the brief"
            title="Copy the brief"
            onClick={() => void copyToClipboard(task, "Brief copied")}
            className="shrink-0 rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <Copy size={13} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="whitespace-pre-wrap font-serif text-[14px] leading-relaxed text-octo-ivory">{task}</p>
        </div>
      </div>
    </ModalShell>
  );
}

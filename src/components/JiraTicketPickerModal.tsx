import type { Issue } from "../lib/types";
import { InlineTicketPicker } from "./InlineTicketPicker";
import { ModalShell } from "./ModalShell";

interface Props {
  candidates: Issue[];
  projectKey: string | null;
  projectId?: string | null;
  title: string;
  onPick: (key: string) => void;
  onClose: () => void;
}

export function JiraTicketPickerModal({ candidates, projectKey, projectId = null, title, onPick, onClose }: Props) {
  return (
    <ModalShell onClose={onClose} ariaLabel={title}>
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
        <div className="flex items-center justify-between border-b border-octo-hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            ESC
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          <InlineTicketPicker
            candidates={candidates}
            projectKey={projectKey}
            projectId={projectId}
            onPick={onPick}
            onCancel={onClose}
          />
        </div>
      </div>
    </ModalShell>
  );
}

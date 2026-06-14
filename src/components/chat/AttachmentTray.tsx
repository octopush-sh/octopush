import { X } from "lucide-react";
import type { Attachment } from "../../lib/types";
import { attachmentDataUrl } from "../../lib/attachments";

interface Props {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

/**
 * Horizontal strip of pending image attachments above the composer textarea.
 * Each chip shows a thumbnail + name with a remove button. Renders nothing when
 * empty (minimalism — the tray earns its space only when it has content).
 */
export function AttachmentTray({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a, i) => (
        <div
          key={`${a.name}-${i}`}
          className="group relative flex items-center gap-2 rounded-md border border-octo-hairline bg-octo-panel py-1 pl-1 pr-2"
        >
          <img
            src={attachmentDataUrl(a)}
            alt={a.name}
            className="h-8 w-8 rounded object-cover"
          />
          <span className="max-w-[10rem] truncate font-mono text-[10px] text-octo-sage">
            {a.name}
          </span>
          <button
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${a.name}`}
            title="Remove attachment"
            className="flex items-center text-octo-mute transition-colors hover:text-octo-rouge"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

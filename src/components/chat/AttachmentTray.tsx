import { useState } from "react";
import { X } from "lucide-react";
import type { Attachment } from "../../lib/types";
import { attachmentDataUrl } from "../../lib/attachments";
import { ModalShell } from "../ModalShell";

interface Props {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

/** Approximate decoded size of a base64 payload, formatted for display. */
function formatAttachmentSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Horizontal strip of pending image attachments above the composer textarea.
 * Each chip shows a thumbnail + name + size; clicking the thumbnail opens a
 * lightbox so the user can verify what they're about to send. Renders nothing
 * when empty (minimalism — the tray earns its space only when it has content).
 */
export function AttachmentTray({ attachments, onRemove }: Props) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a, i) => (
        <div
          key={`${a.name}-${i}`}
          className="group relative flex items-center gap-2 rounded-md border border-octo-hairline bg-octo-panel py-1 pl-1 pr-2"
        >
          <button
            type="button"
            onClick={() => setPreview(a)}
            title={`Preview ${a.name}`}
            aria-label={`Preview ${a.name}`}
            className="rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <img
              src={attachmentDataUrl(a)}
              alt={a.name}
              className="h-8 w-8 rounded object-cover"
            />
          </button>
          <span className="flex flex-col leading-tight">
            <span className="max-w-[10rem] truncate font-mono text-[10px] text-octo-sage">
              {a.name}
            </span>
            <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
              {formatAttachmentSize(a.data)}
            </span>
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

      {preview && (
        <ModalShell onClose={() => setPreview(null)} ariaLabel={`Preview of ${preview.name}`}>
          <div className="flex max-h-[80vh] max-w-[80vw] flex-col gap-2 rounded-lg border border-octo-hairline bg-octo-panel p-3">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[11px] text-octo-sage">{preview.name}</span>
              <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
                {formatAttachmentSize(preview.data)}
              </span>
            </div>
            <img
              src={attachmentDataUrl(preview)}
              alt={preview.name}
              className="max-h-[70vh] max-w-full rounded object-contain"
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}

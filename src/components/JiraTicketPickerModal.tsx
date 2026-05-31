import { useEffect, useRef } from "react";
import type { Issue } from "../lib/types";
import { InlineTicketPicker } from "./InlineTicketPicker";

interface Props {
  candidates: Issue[];
  projectKey: string | null;
  title: string;
  onPick: (key: string) => void;
  onClose: () => void;
}

export function JiraTicketPickerModal({ candidates, projectKey, title, onPick, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-octo-onyx/80 p-6"
      onClick={handleOverlayClick}
    >
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
            onPick={onPick}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}

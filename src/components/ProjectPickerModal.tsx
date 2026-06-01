import { useEffect, useRef } from "react";
import type { ProjectInfo } from "../lib/types";

interface Props {
  candidates: ProjectInfo[];
  title: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}

export function ProjectPickerModal({ candidates, title, onPick, onClose }: Props) {
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
      aria-label="Select Octopush Project"
      className="fixed inset-0 z-50 flex items-center justify-center bg-octo-onyx/80 p-6"
      onClick={handleOverlayClick}
    >
      <div className="flex w-[480px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
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

        <div className="overflow-y-auto py-2">
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition hover:bg-[var(--brass-ghost)]"
            >
              <span className="text-[13px] text-octo-ivory">{p.name}</span>
              <span className="truncate font-mono text-[11px] text-octo-mute">{p.path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

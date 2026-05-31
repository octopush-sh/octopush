import { useEffect, useRef, useState } from "react";

interface Props {
  initialValue: string;
  projectName: string;
  onSave: (value: string | null) => void;
  onClose: () => void;
}

export function JiraProjectKeyModal({ initialValue, projectName, onSave, onClose }: Props) {
  const [value, setValue] = useState(initialValue);
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  function handleSave() {
    const trimmed = value.trim();
    onSave(trimmed === "" ? null : trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-label="Set Jira project key"
      className="fixed inset-0 z-50 flex items-center justify-center bg-octo-onyx/80 p-6"
      onClick={handleOverlayClick}
    >
      <div className="flex w-[400px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
        <div className="flex items-center justify-between border-b border-octo-hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            Set Jira project key
            {projectName && (
              <>
                {" · "}
                <span className="text-octo-brass">{projectName}</span>
              </>
            )}
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

        <div className="p-4">
          <p className="mb-3 text-[12px] text-octo-sage">
            Enter the Jira project key (e.g. <span className="font-mono text-octo-ivory">PROJ</span>). Leave blank to clear the override.
          </p>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="PROJ"
            aria-label="Jira project key"
            className="w-full rounded border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[13px] text-octo-ivory outline-none focus:border-octo-brass"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:text-octo-brass"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

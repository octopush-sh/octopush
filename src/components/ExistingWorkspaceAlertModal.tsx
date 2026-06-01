import { useEffect, useRef } from "react";

interface Props {
  ticketKey: string;
  workspaceName: string;
  onContinue: () => void;
  onCancel: () => void;
}

export function ExistingWorkspaceAlertModal({
  ticketKey,
  workspaceName,
  onContinue,
  onCancel,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) onCancel();
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-label="Workspace already linked"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-octo-onyx/80 p-6"
      onClick={handleOverlayClick}
    >
      <div className="flex w-[440px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
        <div className="flex items-center justify-between border-b border-octo-hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            Workspace already linked
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            ESC
          </button>
        </div>

        <div className="p-4">
          <p className="text-[13px] leading-[1.6] text-octo-sage">
            A workspace is already linked to{" "}
            <span className="font-mono text-octo-brass">{ticketKey}</span>:{" "}
            <span className="text-octo-ivory">&quot;{workspaceName}&quot;</span>.
            Continue creating another, or cancel?
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:text-octo-sage"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

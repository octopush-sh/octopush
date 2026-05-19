import { useEffect } from "react";

interface Props {
  title: string;
  body: string;
  destructiveLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  destructiveLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: Props) {
  // Esc → cancel, Enter → confirm
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-octo-bg/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[420px] rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-dialog-title"
          className="font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory"
        >
          {title}
        </h2>

        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          {body}
        </p>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className="rounded-md px-4 py-2 font-mono text-[11px] text-octo-rouge transition"
            style={{
              background: "rgba(209, 139, 139, 0.1)",
              border: "1px solid rgba(209, 139, 139, 0.3)",
            }}
          >
            {destructiveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

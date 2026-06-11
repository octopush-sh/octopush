import { useEffect, useState } from "react";
import { ModalShell } from "./ModalShell";

interface Props {
  title: string;
  body: string;
  destructiveLabel: string;
  cancelLabel?: string;
  /** Optional third action rendered between Cancel and the confirm,
   *  styled like Cancel. Escape still maps to onCancel only. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  requireInput?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  destructiveLabel,
  cancelLabel = "Cancel",
  secondaryLabel,
  onSecondary,
  requireInput,
  onConfirm,
  onCancel,
}: Props) {
  const [inputValue, setInputValue] = useState("");
  const isConfirmDisabled = requireInput ? inputValue !== requireInput : false;

  // Enter → confirm (Escape → cancel is handled by ModalShell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !isConfirmDisabled) {
        e.preventDefault();
        void onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, isConfirmDisabled]);

  return (
    <ModalShell
      onClose={onCancel}
      closeOnBackdrop={false}
      ariaLabel={title}
      panelClassName="w-full max-w-[420px]"
    >
      <div className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <h2
          className="font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory"
        >
          {title}
        </h2>

        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          {body}
        </p>

        {requireInput && (
          <div className="mt-5 space-y-2">
            <label className="block text-[11px] font-mono text-octo-mute">
              Type "{requireInput}" to confirm:
            </label>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Type here to confirm"
              aria-label={`Type "${requireInput}" to confirm`}
              autoFocus
              className="w-full rounded-md border border-octo-hairline bg-octo-bg px-3 py-2 font-mono text-[11px] text-octo-ivory outline-none transition focus:border-octo-brass"
            />
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory"
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="rounded-md px-4 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={isConfirmDisabled}
            className={`rounded-md border border-[color:var(--rouge-border)] px-4 py-2 font-mono text-[11px] text-octo-rouge transition disabled:cursor-not-allowed disabled:opacity-50 ${
              isConfirmDisabled
                ? "bg-[var(--rouge-disabled-bg)]"
                : "bg-[var(--rouge-active-bg)]"
            }`}
          >
            {destructiveLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

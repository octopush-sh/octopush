import { useEffect, useRef } from "react";

interface Props {
  /** Close handler (Escape, and backdrop click when closeOnBackdrop). */
  onClose: () => void;
  children: React.ReactNode;
  /** Vertical placement. "top" anchors near the top (command palettes). */
  align?: "center" | "top";
  /** Dismiss on backdrop click. Default true; set false for confirm dialogs. */
  closeOnBackdrop?: boolean;
  /** Extra classes for the panel wrapper (sizing/layout lives on the child;
   *  this is only the animated wrapper). */
  panelClassName?: string;
  /** Tailwind top padding for align="top" (e.g. "pt-[18vh]"). */
  topOffset?: string;
  /** Accessible label for the dialog. */
  ariaLabel?: string;
}

/**
 * Standard modal chrome: a tokenized backdrop + centered/top panel with the
 * app's entrance motion, Escape-to-close, and optional click-outside. The
 * canonical way to present a dialog (see CLAUDE.md motion rule / design-system).
 */
export function ModalShell({
  onClose,
  children,
  align = "center",
  closeOnBackdrop = true,
  panelClassName = "",
  topOffset = "pt-[18vh]",
  ariaLabel,
}: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const justify = align === "top" ? `items-start ${topOffset}` : "items-center";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className={`fixed inset-0 z-50 flex justify-center ${justify} bg-octo-onyx/80 p-6 octo-overlay-enter`}
      onClick={closeOnBackdrop ? () => onClose() : undefined}
    >
      <div
        className={`octo-modal-enter ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

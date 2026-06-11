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
const FOCUSABLE_SELECTOR =
  'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

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
  const dialogRef = useRef<HTMLDivElement | null>(null);

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

  // Focus management: move focus into the dialog on mount, hand it back to
  // whatever opened it on unmount (if that element is still in the DOM).
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Tab trap: keep Tab / Shift+Tab cycling inside the dialog.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === root) {
      e.preventDefault();
      first.focus();
    }
  };

  const justify = align === "top" ? `items-start ${topOffset}` : "items-center";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={trapTab}
      className={`fixed inset-0 z-50 flex justify-center ${justify} bg-octo-onyx/80 p-6 outline-none octo-overlay-enter`}
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

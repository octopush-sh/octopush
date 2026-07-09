// OverlayRoom — the full-screen transient "room" shell shared by app-scoped
// overlay surfaces (Settings, Mission Control). A room is NOT a dialog: it
// frames a destination, not an interruption, so it deliberately does not use
// ModalShell. It provides the canonical container (onyx + brass-faint radial
// wash, z-40 beneath ModalShell's z-50 so dialogs stack on top) and the
// capture-phase Escape handling with its two subtleties: defer to any
// ModalShell stacked on top, and never hijack Escape from a focused field.
import { useEffect } from "react";
import { isModalOpen } from "../ModalShell";

interface Props {
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}

export function OverlayRoom({ onClose, ariaLabel, children }: Props) {
  // Esc closes the room. Registered in the capture phase and consuming the
  // event so it never reaches the webview/OS — otherwise, in a maximized
  // (macOS full-screen) window, Escape would exit full-screen instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isModalOpen()) return; // a dialog on top handles its own Escape
      e.preventDefault();
      // If focus is in a field, let that field's own Escape run (e.g. cancel
      // an inline edit) and leave the room open — don't hijack it.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-octo-bg octo-fade-in"
      data-tauri-drag-region
      aria-label={ariaLabel}
      style={{
        // --brass-faint is the accent at 4% alpha, re-derived per theme by
        // themeStore — so the wash follows the active palette.
        background:
          "radial-gradient(ellipse at 20% 10%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {children}
    </div>
  );
}

/** The canonical room-dismiss affordance — top-right `ESC · CLOSE`. */
export function RoomClose({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className="ml-auto rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute hover:text-octo-brass"
    >
      ESC · CLOSE
    </button>
  );
}

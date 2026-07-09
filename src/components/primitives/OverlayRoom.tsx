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

/** Mounted-room stack so Escape only dismisses the topmost (most recently
 *  opened) room when rooms are stacked (e.g. Mission Control over Settings),
 *  instead of both at once — `stopPropagation` cannot stop other listeners on
 *  the same target (window), so ordering has to be explicit. Mirrors
 *  ModalShell's escStack. */
const roomStack: symbol[] = [];

export function OverlayRoom({ onClose, ariaLabel, children }: Props) {
  // Esc closes the room. Registered in the capture phase and consuming the
  // event so it never reaches the webview/OS — otherwise, in a maximized
  // (macOS full-screen) window, Escape would exit full-screen instead.
  useEffect(() => {
    const id = Symbol("overlay-room");
    roomStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isModalOpen()) return; // a dialog on top handles its own Escape
      if (roomStack[roomStack.length - 1] !== id) return; // not the top room
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
      // Also stop any OTHER window listeners (a room below) from acting on
      // this same press — one Escape peels exactly one room.
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const idx = roomStack.indexOf(id);
      if (idx !== -1) roomStack.splice(idx, 1);
    };
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-octo-bg octo-fade-in"
      data-tauri-drag-region
      role="region"
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

/** The canonical room-dismiss affordance — top-right `ESC · CLOSE`. Callers
 *  own its placement (pass `ml-auto` when it's the only right-aligned item;
 *  omit it inside an already right-aligned cluster). */
export function RoomClose({
  onClose,
  label,
  className = "",
}: {
  onClose: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className={`rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute hover:text-octo-brass ${className}`}
    >
      ESC · CLOSE
    </button>
  );
}

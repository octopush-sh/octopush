import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenuChrome } from "../lib/useMenuChrome";

interface Props {
  /** Viewport coordinates (e.clientX / e.clientY or an anchor rect edge). */
  x: number;
  y: number;
  ariaLabel: string;
  onDismiss: () => void;
  /** Tailwind width class for the menu panel. */
  widthClass?: string;
  children: ReactNode;
}

/**
 * The one way to render a context menu. Owns the chrome every menu shares:
 * a portal to document.body with `fixed` positioning (so the menu escapes
 * overflow/scroll containers — the ModelPicker lesson), `z-[60]`, the
 * `.octo-menu-enter` entrance, viewport clamping, focus + arrow-key nav and
 * Escape/outside-click dismissal (via useMenuChrome).
 *
 * Children are the menu rows — use the MENU_* class strings from
 * `src/lib/menuStyles.ts` on `role="menuitem"` buttons.
 */
export function MenuSurface({ x, y, ariaLabel, onDismiss, widthClass = "w-[224px]", children }: Props) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className={`octo-menu-enter fixed z-[60] ${widthClass} rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl`}
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
    >
      {children}
    </div>,
    document.body,
  );
}

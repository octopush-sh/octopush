import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared chrome for the rail context menus:
 *  - clamps the menu into the viewport after measuring it (B9),
 *  - focuses the first menu item on open and supports ↑/↓ nav (B10),
 *  - dismisses on Escape and on outside-click, ignoring right-click (B8).
 *
 * ↑/↓ walk the rows of the menu that holds the focus: a submenu rendered
 * inside the panel (its own `role="menu"`) is walked on its own, and the
 * parent's rows skip it. A control that is not a `menuitem` but belongs in the
 * walk (the one tabbable swatch of a radio row) opts in with `data-menu-item`.
 */
const MENU_ROW = '[role="menuitem"]:not([disabled]), [data-menu-item]:not([disabled])';

export function useMenuChrome(x: number, y: number, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - height - margin));
    setPos({ left, top });
  }, [x, y]);

  useLayoutEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const focused = document.activeElement as HTMLElement | null;
        const inner = focused?.closest<HTMLElement>('[role="menu"]');
        const scope = inner && el.contains(inner) ? inner : el;
        const items = Array.from(scope.querySelectorAll<HTMLElement>(MENU_ROW)).filter(
          (item) => (item.closest('[role="menu"]') ?? scope) === scope,
        );
        if (items.length === 0) return;
        const down = e.key === "ArrowDown";
        const idx = focused ? items.indexOf(focused) : -1;
        if (idx === -1 && focused && scope.contains(focused)) {
          // The focus is in the menu but on something outside the walk (a
          // control reached with the pointer or Tab): go on from where it
          // stands in the document, never back to the top.
          const after = items.findIndex(
            (item) => (focused.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          );
          const following = after === -1 ? items.length : after;
          items[(down ? following : following - 1 + items.length) % items.length]?.focus();
          return;
        }
        const next = down
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) return; // let right-click re-open elsewhere
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Capture phase so the menu wins over bubble-phase listeners registered
    // earlier (e.g. MissionCreator's Escape-to-cancel) — the menu must
    // consume Escape before the creator sees it.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onDismiss]);

  return { ref, pos };
}

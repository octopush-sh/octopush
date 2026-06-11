import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared chrome for the rail context menus:
 *  - clamps the menu into the viewport after measuring it (B9),
 *  - focuses the first menu item on open and supports ↑/↓ nav (B10),
 *  - dismisses on Escape and on outside-click, ignoring right-click (B8).
 */
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
        const items = Array.from(
          el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
        );
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "ArrowDown"
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
    // earlier (e.g. WorkspaceCreator's Escape-to-cancel) — the menu must
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

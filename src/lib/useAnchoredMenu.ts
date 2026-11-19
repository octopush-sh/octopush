import { useCallback, useRef, useState } from "react";

/**
 * A menu opened from a button (`MenuSurface` under it). The button toggles:
 * a click while its menu is open closes it and does not open it again. And
 * when the menu closes — Escape, a press elsewhere, or a pick — keyboard
 * focus goes back to the button that opened it.
 *
 * `place` turns the button's rect into the menu's viewport coordinates.
 */
export function useAnchoredMenu(place: (rect: DOMRect) => { x: number; y: number }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A press on the button closes its open menu first (the menu's
  // outside-press does, on mousedown) and reaches the button later in the
  // same event. The event that closed the menu is remembered, so that press
  // is told apart from a later one exactly, with no timing involved.
  const closedBy = useRef<Event | undefined>(undefined);
  const closedByThisPress = useRef(false);

  const close = useCallback(() => {
    closedBy.current = window.event;
    setMenu(null);
    // A press elsewhere still lands where it was aimed: the browser moves
    // focus to its target after this.
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  /** Close for a pick, then run it. */
  const pick = useCallback(
    (run: () => void) => () => {
      close();
      run();
    },
    [close],
  );

  const buttonProps = {
    ref: buttonRef,
    "aria-haspopup": "menu" as const,
    "aria-expanded": menu !== null,
    onMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => {
      closedByThisPress.current = closedBy.current !== undefined && e.nativeEvent === closedBy.current;
    },
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (closedByThisPress.current) {
        closedByThisPress.current = false;
        return;
      }
      if (menu !== null) {
        close();
        return;
      }
      setMenu(place(e.currentTarget.getBoundingClientRect()));
    },
  };

  return { menu, close, pick, buttonProps };
}

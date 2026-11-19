import { useEffect, useRef, useState } from "react";

/**
 * True while ⌥ is held — the moment the Run session line swaps its icons for
 * jump numbers. The hint arrives exactly when the hand is already on the
 * modifier, and window blur resets it so a Cmd-Tab away can't leave the line
 * stuck.
 *
 * ⌥ only, not ⌘: the jump chord is ⌘⌥N, and every plain ⌘ shortcut (⌘C, ⌘S,
 * ⌘K…) would otherwise flash the whole line on its way past.
 */
export function useModifierPeek(): boolean {
  const [peek, setPeek] = useState(false);
  const peekRef = useRef(peek);
  peekRef.current = peek;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const next = e.altKey;
      if (next !== peekRef.current) setPeek(next);
    };
    const off = () => {
      if (peekRef.current) setPeek(false);
    };
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  return peek;
}

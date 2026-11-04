import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * The Companion's fold while Run shows more than one pane
 * (docs/superpowers/specs/2026-11-03-run-session-pair-design.md, "Companion").
 * `panesFold` folds it to its strip (`folded`); a toggle then brings it back
 * `over` the panes until the next fold. Every toggle is also the user's
 * explicit choice (`collapsed`), which is what returning to one pane restores.
 */
export function useCompanionFold(
  panesFold: boolean,
  collapsed: boolean,
  setCollapsed: Dispatch<SetStateAction<boolean>>,
) {
  const [over, setOver] = useState(false);
  useEffect(() => setOver(false), [panesFold]);
  const live = useRef({ panesFold, over });
  live.current = { panesFold, over };

  const toggle = useCallback(() => {
    const now = live.current;
    if (now.panesFold) {
      setOver(!now.over);
      setCollapsed(now.over);
    } else {
      setCollapsed((v) => !v);
    }
  }, [setCollapsed]);

  return {
    collapsed: panesFold ? !over : collapsed,
    folded: panesFold && !over,
    over: panesFold && over,
    toggle,
  };
}

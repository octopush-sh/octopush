import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ModeOverlay } from "./ModeOverlay";
import { placements, useTerminalSlotsStore, type SlotMode } from "../stores/terminalSlotsStore";

interface Props {
  /** The mode on screen when it is one that shows terminals, else null. */
  mode: SlotMode | null;
  /** Every session that has a pane, across all workspaces. */
  terminalIds: string[];
  /** Renders one session's `TerminalPane`; `shown` is whether it has a slot
   *  in the active mode. */
  renderPane: (terminalId: string, shown: boolean) => ReactNode;
}

/**
 * The one always-mounted layer that holds every `TerminalPane`, a sibling of
 * the mode overlays. Each pane sits in a frame positioned over its slot in
 * the active mode (`TerminalSlot`); a pane with no slot there stays
 * `display:none`. Frames are keyed by session and never re-parented, so a
 * pane never remounts. The layer fades with the same transition as the mode
 * overlays, so a terminal never appears abruptly.
 */
export function TerminalHost({ mode, terminalIds, renderPane }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState({ left: 0, top: 0 });
  const slots = useTerminalSlotsStore((s) => s.slots);

  // Slots publish viewport rects; the frames are placed relative to this
  // layer, so follow where it sits.
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setOrigin((o) => (o.left === r.left && o.top === r.top ? o : { left: r.left, top: r.top }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const placed = placements(slots, mode, origin);

  return (
    <ModeOverlay active={mode !== null} passThrough>
      <div ref={ref} data-testid="terminal-host" className="contents">
        {terminalIds.map((id) => {
          const rect = placed[id];
          return (
            <div
              key={id}
              data-terminal-frame={id}
              className="absolute overflow-hidden"
              style={
                rect
                  ? {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                      pointerEvents: "auto",
                    }
                  : { display: "none" }
              }
            >
              {renderPane(id, !!rect)}
            </div>
          );
        })}
      </div>
    </ModeOverlay>
  );
}

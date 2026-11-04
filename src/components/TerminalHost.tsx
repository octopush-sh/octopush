import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ModeOverlay } from "./ModeOverlay";
import { ErrorBoundary } from "./ErrorBoundary";
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
 *
 * The Run error boundary sits inside the layer, so its card fades with the
 * layer and shows only in a terminal mode; the card takes the pointer itself
 * so Try again stays clickable. Try again remounts the panes, which reattach
 * to their PTYs in the daemon.
 */
export function TerminalHost({ mode, terminalIds, renderPane }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const slots = useTerminalSlotsStore((s) => s.slots);
  const origin = useTerminalSlotsStore((s) => s.origin);

  // Slots publish viewport rects; the frames are placed relative to this
  // layer, so follow where it sits. The origin goes through the store so it
  // lands in the same synchronous render as the slot rects (never a frame late).
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      useTerminalSlotsStore.getState().setOrigin({ left: r.left, top: r.top });
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
        <ErrorBoundary surface="Run" interactive>
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
        </ErrorBoundary>
      </div>
    </ModeOverlay>
  );
}

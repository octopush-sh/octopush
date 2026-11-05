import { useEffect, useRef, useState, type ReactNode } from "react";
import { SquareTerminal, X } from "lucide-react";
import { useTerminalsStore } from "../../stores/terminalsStore";
import { EMPTY_TALK_SEAT, setTalkWidth, useTerminalLayoutStore } from "../../stores/terminalLayoutStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { tourId } from "../../lib/tour/ids";
import { prefersReducedMotion } from "../../lib/motion";
import { TerminalSlot } from "../TerminalSlot";
import { FadeSwap } from "../primitives/FadeSwap";
import { EmptySeat } from "../run/RunPanes";

interface Props {
  workspaceId: string;
  /** Open the seat or close it (the icon, `×`, ⌘D). */
  onToggle: () => void;
  /** Open the pairing switcher for the seat. */
  onPick: () => void;
  /** The conversation column. */
  children: ReactNode;
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/**
 * The most the seat may take of the canvas: what leaves the conversation its
 * `--talk-chat-min` (the composer at its natural size). When that would leave
 * the terminal under `--talk-seat-min` (about 40 columns), the seat keeps that
 * much instead and the conversation narrows, never past `--talk-chat-floor`;
 * the composer's control bar wraps there, so nothing of it is ever covered.
 */
const SEAT_CAP =
  "max(100% - var(--talk-chat-min), min(var(--talk-seat-min), 100% - var(--talk-chat-floor)))";

/**
 * Talk with one terminal beside the conversation
 * (docs/superpowers/specs/2026-11-03-run-session-pair-design.md, "Talk"). The
 * seat holds one of Run's sessions, the same PTY: it is only a `TerminalSlot`,
 * and `TerminalHost` draws the pane over it. Focus in the seat is Talk's own
 * (`talkFocusedByWs`); it never changes `activeByWs` or Run's focused slot.
 */
export function TalkSeat({ workspaceId, onToggle, onPick, children }: Props) {
  const seat = useTerminalLayoutStore((s) => s.talkByWs[workspaceId] ?? EMPTY_TALK_SEAT);
  const resizing = useTerminalLayoutStore((s) => s.resizing);
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  // Before the first `loadTerminals` a restored session isn't listed yet:
  // the seat stays blank rather than flash an empty seat.
  const known = useTerminalsStore((s) => workspaceId in s.terminalsByWs);
  const createInTalkSeat = useTerminalsStore((s) => s.createInTalkSeat);
  const areaRef = useRef<HTMLDivElement>(null);
  const seatRef = useRef<HTMLDivElement>(null);
  const session = terminals.find((t) => t.id === seat.terminalId) ?? null;
  const Icon = iconForSessionRole(session?.role ?? "shell");
  const { updateTalk, setTalkFocused, setResizing } = useTerminalLayoutStore.getState();

  // The contents stay mounted through the closing width glide and go at its
  // `transitionend` (at once with reduced motion, or with no glide mid-drag).
  const [mounted, setMounted] = useState(seat.open);
  useEffect(() => {
    if (seat.open) setMounted(true);
    // `resizing` as rendered: the drag cleanup below may already have reset it.
    else if (prefersReducedMotion() || resizing) setMounted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seat.open]);
  // A workspace switch is not a close: the other seat shows as it is.
  const [shownWs, setShownWs] = useState(workspaceId);
  if (shownWs !== workspaceId) {
    setShownWs(workspaceId);
    setMounted(seat.open);
  }

  const setWidth = (w: number) => updateTalk(workspaceId, (s) => setTalkWidth(s, w));
  // The share the seat shows: its width can be capped below `seat.width`.
  const shownWidth = () => {
    const area = areaRef.current?.getBoundingClientRect().width ?? 0;
    const own = seatRef.current?.getBoundingClientRect().width ?? 0;
    return area > 0 && own > 0 ? Math.min(seat.width, own / area) : seat.width;
  };
  const drag = (on: boolean) => {
    setResizing(on);
    document.body.style.cursor = on ? "col-resize" : "";
    // A drag past the cap keeps what it showed, so the next drag or arrow key
    // moves the seat at once instead of first crossing the capped stretch.
    if (!on) {
      const shown = shownWidth();
      if (shown < seat.width - 0.005) setWidth(shown);
    }
  };

  // A drag that never sees its release (the seat closes mid-drag) must not
  // leave every PTY waiting for its size.
  useEffect(() => {
    if (!seat.open) return;
    return () => {
      if (!useTerminalLayoutStore.getState().resizing) return;
      useTerminalLayoutStore.getState().setResizing(false);
      document.body.style.cursor = "";
    };
  }, [seat.open]);

  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

  return (
    <div ref={areaRef} className="flex h-full min-h-0 w-full">
      {/* Typing in the conversation takes keyboard focus back from the seat. */}
      <div className="relative min-w-0 flex-1" onFocusCapture={() => setTalkFocused(workspaceId, false)}>
        {children}
        <button
          type="button"
          data-testid="talk-seat-toggle"
          data-tour={tourId("talk-seat-toggle")}
          aria-pressed={seat.open}
          aria-label="Open a terminal beside the conversation"
          title="Open a terminal beside the conversation · ⌘D"
          onClick={onToggle}
          className={`absolute right-3 top-3 z-10 ${iconButton} ${seat.open ? "text-octo-ivory" : ""}`}
        >
          <SquareTerminal size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div
        ref={seatRef}
        data-testid="talk-seat"
        className="relative flex min-h-0 shrink-0 flex-col"
        style={{
          width: seat.open ? `min(${seat.width * 100}%, ${SEAT_CAP})` : 0,
          transition: resizing ? undefined : "width var(--dur-standard) var(--ease-octo)",
        }}
        onTransitionEnd={(e) => {
          // Only the seat's own width glides; its children's colour fades bubble here too.
          if (e.target === e.currentTarget && !seat.open) setMounted(false);
        }}
      >
        {mounted && (
          <>
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize the panes"
              aria-valuenow={Math.round(seat.width * 100)}
              aria-valuemin={20}
              aria-valuemax={80}
              title="Drag to resize · Double-click to even"
              data-testid="talk-seat-divider"
              onPointerDown={(e) => {
                if (e.button !== 0 || !seat.open) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                drag(true);
              }}
              onPointerMove={(e) => {
                const r = areaRef.current?.getBoundingClientRect();
                if (resizing && r && r.width > 0) setWidth((r.right - e.clientX) / r.width);
              }}
              onPointerUp={() => drag(false)}
              onPointerCancel={() => drag(false)}
              onKeyDown={(e) => {
                // The seat is on the right: moving the divider left widens it.
                const step = e.shiftKey ? FINE_STEP : STEP;
                if (e.key === "ArrowLeft") setWidth(shownWidth() + step);
                else if (e.key === "ArrowRight") setWidth(shownWidth() - step);
                else return;
                e.preventDefault();
              }}
              onDoubleClick={() => setWidth(0.5)}
              // Lifted above the TerminalHost frames, as Run's dividers are.
              className="group absolute inset-y-0 left-0 z-10 w-px cursor-col-resize bg-octo-border focus-visible:outline-none"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 -left-[3px] -right-[3px] transition-colors duration-[180ms] group-hover:bg-[var(--brass-faint)] group-focus-visible:bg-[var(--brass-ghost)]"
              />
            </div>
            <div className="ml-px flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="octo-rise-in flex h-8 shrink-0 items-center gap-1 border-b border-octo-hairline px-2">
                <button
                  type="button"
                  onClick={onPick}
                  title={session ? `${session.label} — choose another session` : "Choose a session for this seat"}
                  className="flex min-w-0 flex-1 items-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  <FadeSwap swapKey={seat.terminalId ?? ""} className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2 py-0.5 font-mono text-[11px] tracking-[0.04em] text-octo-ivory">
                      {session && <Icon size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />}
                      <span className="min-w-0 truncate">{session?.label}</span>
                    </span>
                  </FadeSwap>
                </button>
                <button
                  type="button"
                  aria-label="Leave the view"
                  title="Leave the view · the session keeps running"
                  data-testid="talk-seat-leave"
                  onClick={onToggle}
                  className={iconButton}
                >
                  <X size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
              <div className="relative min-h-0 flex-1">
                {!known ? null : session ? (
                  <TerminalSlot mode="talk" terminalId={session.id} />
                ) : (
                  <EmptySeat
                    mode="talk"
                    onOpen={onPick}
                    onCreate={() => createInTalkSeat(workspaceId).catch(console.error)}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

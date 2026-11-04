import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { useTerminalsStore } from "../../stores/terminalsStore";
import {
  evenRatios,
  focus,
  leave,
  setRatios,
  swap,
  useTerminalLayoutStore,
} from "../../stores/terminalLayoutStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { MENU_HEADER, MENU_ITEM, MENU_SEP } from "../../lib/menuStyles";
import { tourId } from "../../lib/tour/ids";
import { MenuSurface } from "../MenuSurface";
import { TerminalSlot } from "../TerminalSlot";
import { FadeSwap } from "../primitives/FadeSwap";

interface Props {
  workspaceId: string;
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/**
 * Run's panes (docs/superpowers/specs/2026-11-03-run-session-pair-design.md).
 * One pane is today's full canvas. Two sit side by side, each under a caption
 * naming its session, split by a 1px divider. Each pane is only a
 * `TerminalSlot`: `TerminalHost` draws the session's terminal over it.
 */
export function RunPanes({ workspaceId }: Props) {
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const layout = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  const resizing = useTerminalLayoutStore((s) => s.resizing);
  const updateLayout = useTerminalsStore((s) => s.updateLayout);
  const rowRef = useRef<HTMLDivElement>(null);

  const slots = layout?.slots ?? [activeId];
  const paired = slots.length > 1 && !!layout;

  // A drag that never sees its release (the view drops to one pane, or Run
  // unmounts mid-drag) must not leave every PTY waiting for its size.
  useEffect(() => {
    if (!paired) return;
    return () => {
      if (!useTerminalLayoutStore.getState().resizing) return;
      useTerminalLayoutStore.getState().setResizing(false);
      document.body.style.cursor = "";
    };
  }, [paired]);

  if (!paired || !layout) {
    return <TerminalSlot mode="run" terminalId={slots[0] ?? null} />;
  }

  const split = layout.ratios[0] ?? 0.5;
  const setSplit = (r: number) => updateLayout(workspaceId, (l) => setRatios(l, [r]));

  // The divider captures the pointer for the drag; `resizing` makes the panes
  // refit on frames and tell their PTYs the size only on release.
  const drag = (on: boolean) => {
    useTerminalLayoutStore.getState().setResizing(on);
    document.body.style.cursor = on ? "col-resize" : "";
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = rowRef.current?.getBoundingClientRect();
    if (resizing && r && r.width > 0) setSplit((e.clientX - r.left) / r.width);
  };

  const onDividerKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? FINE_STEP : STEP;
    if (e.key === "ArrowLeft") setSplit(split - step);
    else if (e.key === "ArrowRight") setSplit(split + step);
    else return;
    e.preventDefault();
  };

  // Sizes glide on the standard clock, except while a divider is dragged.
  const size = resizing ? undefined : "flex-basis var(--dur-standard) var(--ease-octo)";

  return (
    <div ref={rowRef} className="flex h-full w-full min-w-0">
      {slots.map((id, i) => (
        <div key={i} className="contents">
          {i > 0 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize the panes"
              aria-valuenow={Math.round(split * 100)}
              aria-valuemin={20}
              aria-valuemax={80}
              title="Drag to resize · Double-click to even"
              data-tour={tourId("run-pane-divider")}
              data-testid="run-pane-divider"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                drag(true);
              }}
              onPointerMove={onPointerMove}
              onPointerUp={() => drag(false)}
              onPointerCancel={() => drag(false)}
              onKeyDown={onDividerKey}
              onDoubleClick={() => setSplit(evenRatios(2)[0])}
              // A 1px hairline with a wider, invisible grip around it. The
              // TerminalHost frames paint over the Run canvas, so the divider
              // lifts itself (and its grip) above them, as the rail does.
              className="group relative z-10 w-px shrink-0 cursor-col-resize bg-octo-border focus-visible:outline-none"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 -left-[3px] -right-[3px] transition-colors duration-[180ms] group-hover:bg-[var(--brass-faint)] group-focus-visible:bg-[var(--brass-ghost)]"
              />
            </div>
          )}
          <div
            className="flex min-w-0 flex-col"
            style={
              i === 0
                ? { flex: `0 0 calc(${split * 100}% - 0.5px)`, transition: size }
                : { flex: "1 1 0%" }
            }
          >
            <PaneCaption
              workspaceId={workspaceId}
              slot={i}
              terminalId={id}
              focused={i === layout.focused}
              others={slots.map((other, j) => ({ slot: j, id: other })).filter((o) => o.slot !== i)}
              onFocus={() => updateLayout(workspaceId, (l) => focus(l, i))}
              onSwap={(j) => updateLayout(workspaceId, (l) => swap(l, i, j))}
              onLeave={() => updateLayout(workspaceId, (l) => leave(l, i))}
            />
            <div className="relative min-h-0 flex-1">
              <TerminalSlot mode="run" terminalId={id} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface CaptionProps {
  workspaceId: string;
  slot: number;
  terminalId: string | null;
  focused: boolean;
  others: { slot: number; id: string | null }[];
  onFocus: () => void;
  onSwap: (slot: number) => void;
  onLeave: () => void;
}

/** One pane's caption: its session's icon and label, the pane menu and `×`. */
function PaneCaption({
  workspaceId,
  slot,
  terminalId,
  focused,
  others,
  onFocus,
  onSwap,
  onLeave,
}: CaptionProps) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const session = terminals.find((t) => t.id === terminalId) ?? null;
  const Icon = iconForSessionRole(session?.role ?? "shell");

  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

  return (
    <div
      data-testid={`run-pane-caption-${slot}`}
      data-tour={slot === 0 ? tourId("run-pane-caption") : undefined}
      data-focused={focused ? "true" : "false"}
      className="octo-rise-in flex h-8 shrink-0 items-center gap-1 border-b border-octo-hairline px-2"
    >
      <button
        type="button"
        onClick={onFocus}
        aria-pressed={focused}
        title={session ? `${session.label} — focus this pane` : undefined}
        className="flex min-w-0 flex-1 items-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <FadeSwap swapKey={terminalId ?? ""} className="min-w-0">
          <span
            className={`flex min-w-0 items-center gap-2 border-b py-0.5 font-mono text-[11px] tracking-[0.04em] transition-colors duration-[var(--dur-standard)] ${
              focused ? "border-octo-border-strong text-octo-ivory" : "border-transparent text-octo-mute"
            }`}
          >
            <Icon size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="min-w-0 truncate">{session?.label}</span>
          </span>
        </FadeSwap>
      </button>
      <button
        type="button"
        aria-label="Pane options"
        title="Pane options"
        aria-haspopup="menu"
        data-testid={`run-pane-menu-${slot}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
        className={iconButton}
      >
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Leave the view"
        title="Leave the view · the session keeps running"
        data-testid={`run-pane-leave-${slot}`}
        onClick={onLeave}
        className={iconButton}
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>

      {menu && (
        <MenuSurface x={menu.x} y={menu.y} ariaLabel="Pane options" onDismiss={() => setMenu(null)}>
          <div className={MENU_HEADER}>Swap with…</div>
          {others.map((o) => (
            <button
              key={o.slot}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setMenu(null);
                onSwap(o.slot);
              }}
            >
              <span className="min-w-0 truncate">{terminals.find((t) => t.id === o.id)?.label}</span>
            </button>
          ))}
          <div className={MENU_SEP} />
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setMenu(null);
              onLeave();
            }}
          >
            Leave the view
          </button>
        </MenuSurface>
      )}
    </div>
  );
}

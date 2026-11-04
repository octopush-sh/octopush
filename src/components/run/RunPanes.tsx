import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, X } from "lucide-react";
import { useTerminalsStore } from "../../stores/terminalsStore";
import {
  evenRatios,
  focus,
  leaveView,
  paneGrid,
  resolveOrientation,
  setOrientation,
  setRatios,
  swap,
  useTerminalLayoutStore,
  type GridArea,
  type Orientation,
} from "../../stores/terminalLayoutStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { terminalCellWidth } from "../../lib/xtermTheme";
import { MENU_HEADER, MENU_ITEM, MENU_SEP } from "../../lib/menuStyles";
import { tourId } from "../../lib/tour/ids";
import { MenuSurface } from "../MenuSurface";
import { TerminalSlot } from "../TerminalSlot";
import { FadeSwap } from "../primitives/FadeSwap";

interface Props {
  workspaceId: string;
  /** Open beside: the pairing switcher, here for the empty seat. */
  onOpenBeside: () => void;
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/**
 * Run's panes (docs/superpowers/specs/2026-11-03-run-session-pair-design.md).
 * One pane is today's full canvas. Two to four sit in fixed positions in one
 * 2×2 grid (`paneGrid`), each under a caption naming its session, split by 1px
 * dividers; two and three side by side or stacked (`resolveOrientation`), four
 * a 2×2 grid around one shared cross. Each pane is only a
 * `TerminalSlot`: `TerminalHost` draws the session's terminal over it. An
 * empty seat (at most one) invites a session instead.
 */
export function RunPanes({ workspaceId, onOpenBeside }: Props) {
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const layout = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  const resizing = useTerminalLayoutStore((s) => s.resizing);
  const updateLayout = useTerminalsStore((s) => s.updateLayout);
  const createBeside = useTerminalsStore((s) => s.createBeside);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // What each workspace last drew: a drag holds that orientation, and while
  // stacked at the same count `auto` measures the side-by-side split last
  // drawn, which the stacked dividers never move.
  const drawn = useRef(new Map<string, { orientation: "side" | "stacked"; sideSplit: number; count: number }>());

  const slots = layout?.slots ?? [activeId];
  const paired = slots.length > 1 && !!layout;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!paired || !el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [paired]);

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

  const count = slots.length;
  const last = drawn.current.get(workspaceId);
  // A new count evens the dividers, so a split kept for the old one is void.
  const kept = last?.orientation === "stacked" && last.count === count;
  const sideSplit = kept ? last.sideSplit : (layout.ratios[0] ?? 0.5);
  const orientation =
    resizing && last
      ? last.orientation
      : resolveOrientation(layout, width, terminalCellWidth(), sideSplit);
  drawn.current.set(workspaceId, { orientation, sideSplit, count });
  const grid = paneGrid(count, orientation, layout.ratios);

  const setRatio = (index: number, r: number) =>
    updateLayout(workspaceId, (l) => {
      const even = evenRatios(l.slots.length);
      const base = l.ratios.length === even.length ? l.ratios : even;
      return setRatios(l, base.map((x, i) => (i === index ? r : x)));
    });

  // A divider captures the pointer for the drag; `resizing` makes the panes
  // refit on frames and tell their PTYs the size only on release.
  const drag = (on: boolean, axis: "x" | "y" = "x") => {
    useTerminalLayoutStore.getState().setResizing(on);
    document.body.style.cursor = on ? (axis === "x" ? "col-resize" : "row-resize") : "";
  };

  // Sizes glide on the standard clock, except while a divider is dragged: the
  // panes through their grid tracks, the dividers along with them.
  const glide = (props: string[]) =>
    resizing ? undefined : props.map((p) => `${p} var(--dur-standard) var(--ease-octo)`).join(", ");
  const fr = (t: [number, number]) => `${t[0]}fr ${t[1]}fr`;

  return (
    <div
      ref={areaRef}
      data-orientation={orientation}
      className="relative grid h-full w-full min-w-0"
      style={{
        gridTemplateColumns: fr(grid.columns),
        gridTemplateRows: fr(grid.rows),
        transition: glide(["grid-template-columns", "grid-template-rows"]),
      }}
    >
      {grid.dividers.map((d) => {
        const at = layout.ratios[d.ratio] ?? 0.5;
        const x = d.axis === "x";
        const onKey = (e: React.KeyboardEvent) => {
          const step = e.shiftKey ? FINE_STEP : STEP;
          const back = x ? "ArrowLeft" : "ArrowUp";
          const fwd = x ? "ArrowRight" : "ArrowDown";
          if (e.key === back) setRatio(d.ratio, at - step);
          else if (e.key === fwd) setRatio(d.ratio, at + step);
          else return;
          e.preventDefault();
        };
        return (
          <div
            key={d.ratio}
            role="separator"
            tabIndex={0}
            aria-orientation={x ? "vertical" : "horizontal"}
            aria-label="Resize the panes"
            aria-valuenow={Math.round(at * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            title="Drag to resize · Double-click to even"
            data-tour={d.ratio === 0 ? tourId("run-pane-divider") : undefined}
            data-testid={`run-pane-divider-${d.ratio}`}
            data-axis={d.axis}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture?.(e.pointerId);
              drag(true, d.axis);
            }}
            onPointerMove={(e) => {
              const r = areaRef.current?.getBoundingClientRect();
              if (!resizing || !r) return;
              if (x && r.width > 0) setRatio(d.ratio, (e.clientX - r.left) / r.width);
              if (!x && r.height > 0) setRatio(d.ratio, (e.clientY - r.top) / r.height);
            }}
            onPointerUp={() => drag(false)}
            onPointerCancel={() => drag(false)}
            onKeyDown={onKey}
            onDoubleClick={() => setRatio(d.ratio, 0.5)}
            // A 1px hairline with a wider, invisible grip around it. The
            // TerminalHost frames paint over the Run canvas, so the divider
            // lifts itself (and its grip) above them, as the rail does.
            className={`group absolute z-10 bg-octo-border focus-visible:outline-none ${
              x ? "cursor-col-resize" : "cursor-row-resize"
            }`}
            style={
              x
                ? { left: `calc(${d.at * 100}% - 0.5px)`, top: pct(d.from), width: 1, height: pct(d.to - d.from), transition: glide(["left", "top", "height"]) }
                : { top: `calc(${d.at * 100}% - 0.5px)`, left: pct(d.from), height: 1, width: pct(d.to - d.from), transition: glide(["left", "top", "width"]) }
            }
          >
            <span
              aria-hidden
              className={`absolute transition-colors duration-[180ms] group-hover:bg-[var(--brass-faint)] group-focus-visible:bg-[var(--brass-ghost)] ${
                x ? "inset-y-0 -left-[3px] -right-[3px]" : "inset-x-0 -top-[3px] -bottom-[3px]"
              }`}
            />
          </div>
        );
      })}
      {slots.map((id, i) => (
        <div
          key={i}
          data-testid={`run-pane-${i}`}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          style={{
            gridColumn: grid.areas[i].column.join(" / "),
            gridRow: grid.areas[i].row.join(" / "),
            ...paneInset(grid.areas[i]),
          }}
        >
          <PaneCaption
            workspaceId={workspaceId}
            slot={i}
            terminalId={id}
            focused={i === layout.focused}
            others={slots
              .map((other, j) => ({ slot: j, id: other }))
              .filter((o) => o.slot !== i && o.id !== null)}
            orientation={count < 4 ? layout.orientation : null}
            onFocus={() => updateLayout(workspaceId, (l) => focus(l, i))}
            onSwap={(j) => updateLayout(workspaceId, (l) => swap(l, i, j))}
            onOrient={(o) => updateLayout(workspaceId, (l) => setOrientation(l, o))}
            onLeave={() => updateLayout(workspaceId, (l) => leaveView(l, i))}
          />
          <div className="relative min-h-0 flex-1">
            {id === null ? (
              <EmptySeat
                onOpen={() => {
                  updateLayout(workspaceId, (l) => focus(l, i));
                  onOpenBeside();
                }}
                onCreate={() => createBeside(workspaceId).catch(console.error)}
              />
            ) : (
              <TerminalSlot mode="run" terminalId={id} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const pct = (f: number) => `${f * 100}%`;

/** A pane's margins in its grid area: half a pixel to each divider it touches
 *  (any grid line but the outer ones, 1 and 3). */
function paneInset({ column, row }: GridArea): React.CSSProperties {
  const px = (line: number) => (line === 2 ? "0.5px" : 0);
  return { marginLeft: px(column[0]), marginRight: px(column[1]), marginTop: px(row[0]), marginBottom: px(row[1]) };
}

/**
 * The empty seat Open beside leaves when every session is already on screen.
 * A click anywhere opens the pairing switcher for it; the CTA opens a new
 * session straight into it.
 */
function EmptySeat({ onOpen, onCreate }: { onOpen: () => void; onCreate: () => void }) {
  return (
    <div
      data-testid="run-empty-seat"
      data-tour={tourId("run-empty-seat")}
      title="Choose a session for this seat · ⌘D"
      onClick={onOpen}
      className="octo-fade-in flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Beside</span>
      <p className="font-serif text-[15px] text-octo-ivory">Bring a session alongside.</p>
      <button
        type="button"
        data-testid="run-empty-seat-new"
        onClick={(e) => {
          e.stopPropagation();
          onCreate();
        }}
        className="rounded-lg border border-octo-border-strong px-3 py-2 font-serif text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        Open a new session here
      </button>
    </div>
  );
}

interface CaptionProps {
  workspaceId: string;
  slot: number;
  terminalId: string | null;
  focused: boolean;
  others: { slot: number; id: string | null }[];
  /** The workspace's orientation, or null at four panes (always a 2×2 grid). */
  orientation: Orientation | null;
  onFocus: () => void;
  onSwap: (slot: number) => void;
  onOrient: (orientation: Orientation) => void;
  onLeave: () => void;
}

const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: "stacked", label: "Stack" },
  { value: "side", label: "Side by side" },
  { value: "auto", label: "Automatic" },
];

/** One pane's caption: its session's icon and label, the pane menu and `×`. */
function PaneCaption({
  workspaceId,
  slot,
  terminalId,
  focused,
  others,
  orientation,
  onFocus,
  onSwap,
  onOrient,
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
            {session && <Icon size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />}
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
        data-tour={slot === 0 ? tourId("run-pane-menu") : undefined}
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
          {orientation !== null && (
            <>
              <div className={MENU_SEP} />
              {ORIENTATIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={orientation === o.value}
                  data-tour={slot === 0 && o.value === "auto" ? tourId("run-pane-orientation") : undefined}
                  title={o.value === "auto" ? "Side by side while every pane keeps 72 columns" : undefined}
                  className={MENU_ITEM}
                  onClick={() => {
                    setMenu(null);
                    onOrient(o.value);
                  }}
                >
                  {/* The checked item's Check, in a fixed 14px icon column. */}
                  <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                    {orientation === o.value && <Check size={13} strokeWidth={1.75} />}
                  </span>
                  {o.label}
                </button>
              ))}
            </>
          )}
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

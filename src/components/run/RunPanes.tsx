import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minus, MoreHorizontal } from "lucide-react";
import { useTerminalsStore } from "../../stores/terminalsStore";
import {
  EMPTY_RUN_LAYOUT,
  evenRatios,
  focus,
  leaveView,
  paneGrid,
  resolveOrientation,
  setRatios,
  splitOrientation,
  swap,
  useTerminalLayoutStore,
  type GridArea,
  type RunLayout,
} from "../../stores/terminalLayoutStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { ROLE_WORD } from "../../lib/sessionRole";
import { sessionDoing } from "../../lib/sessionDoing";
import { terminalCellWidth } from "../../lib/xtermTheme";
import { MENU_HEADER, MENU_ITEM, MENU_ITEM_ROUGE, MENU_SEP } from "../../lib/menuStyles";
import { tourId } from "../../lib/tour/ids";
import { MenuSurface } from "../MenuSurface";
import { TerminalSlot } from "../TerminalSlot";
import { FadeSwap } from "../primitives/FadeSwap";
import { PaneWaiting } from "./PaneWaiting";

interface Props {
  workspaceId: string;
  /** Open beside: the pairing switcher, here for the empty seat. */
  onOpenBeside: () => void;
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/**
 * Run's panes (docs/superpowers/specs/2026-11-03-run-session-pair-design.md).
 * One to four sit in fixed positions in one 2×2 grid (`paneGrid`), each under
 * a caption that is its session's one home (name, what it is doing, its
 * actions) — a lone pane keeps its caption too. Two to four are split by 1px
 * dividers; two and three side by side or stacked (`resolveOrientation`), four
 * a 2×2 grid around one shared cross. Each pane is only a `TerminalSlot`:
 * `TerminalHost` draws the session's terminal over it. An empty seat (at most
 * one) invites a session instead.
 */
export function RunPanes({ workspaceId, onOpenBeside }: Props) {
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const stored = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  const resizing = useTerminalLayoutStore((s) => s.resizing);
  const updateLayout = useTerminalsStore((s) => s.updateLayout);
  const createBeside = useTerminalsStore((s) => s.createBeside);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // A workspace seen for the first time is one pane holding whatever is active.
  const layout: RunLayout = stored ?? { ...EMPTY_RUN_LAYOUT, slots: [activeId] };
  const slots = layout.slots;
  const paired = slots.length > 1;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // How two or three panes sit at this width, for the layout button: it shows
  // the layout on screen, and only this component measures the canvas.
  const split = splitOrientation(layout, width, terminalCellWidth());
  useEffect(() => {
    useTerminalLayoutStore.getState().setSplit(workspaceId, split);
  }, [workspaceId, split]);

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

  const count = slots.length;
  // From the width and the count alone: a divider drag never flips it.
  const orientation = resolveOrientation(layout, width, terminalCellWidth());
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
            // lifts itself (and its grip) above them.
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
          {/* A lone pane with no session yet has nothing to name. */}
          {(paired || id !== null) && (
            <PaneCaption
              workspaceId={workspaceId}
              slot={i}
              terminalId={id}
              focused={i === layout.focused}
              split={paired}
              others={slots
                .map((other, j) => ({ slot: j, id: other }))
                .filter((o) => o.slot !== i && o.id !== null)}
              onFocus={() => updateLayout(workspaceId, (l) => focus(l, i))}
              onSwap={(j) => updateLayout(workspaceId, (l) => swap(l, i, j))}
              onLeave={() => updateLayout(workspaceId, (l) => leaveView(l, i))}
              onOpenBeside={onOpenBeside}
            />
          )}
          <div className="relative min-h-0 flex-1">
            {id === null && !paired ? null : id === null ? (
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
 * The empty seat Open beside leaves when every session is already on screen
 * (also Talk's seat before it holds a session). A click anywhere opens the
 * pairing switcher for it; the CTA opens a new session straight into it.
 */
export function EmptySeat({
  onOpen,
  onCreate,
  mode = "run",
}: {
  onOpen: () => void;
  onCreate: () => void;
  mode?: "run" | "talk";
}) {
  return (
    <div
      data-testid={`${mode}-empty-seat`}
      data-tour={mode === "run" ? tourId("run-empty-seat") : undefined}
      // In Talk, ⌘D closes the seat rather than filling it.
      title={mode === "run" ? "Choose a session for this seat · ⌘D" : "Choose a session for this seat"}
      onClick={onOpen}
      className="octo-fade-in flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Beside</span>
      <p className="font-serif text-[15px] text-octo-ivory">Bring a session alongside.</p>
      <button
        type="button"
        data-testid={`${mode}-empty-seat-new`}
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
  /** More than one pane is on screen: the caption can swap and leave. */
  split: boolean;
  others: { slot: number; id: string | null }[];
  onFocus: () => void;
  onSwap: (slot: number) => void;
  onLeave: () => void;
  /** Open beside: the pairing switcher, or an empty seat (App decides). */
  onOpenBeside: () => void;
}

/** How long after a rename opens a lost focus is the pane taking it, not the
 *  user leaving: focusing a pane hands the keyboard to its terminal 50ms
 *  later (`TerminalPane`), which can land on a quick double-click's input. */
const RENAME_SETTLE_MS = 250;

const CAPTION_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

/** A menu row's right-hand hint: a shortcut, or how else to get there. */
const MENU_HINT = "ml-auto shrink-0 pl-3 text-[10px] text-octo-mute";

/**
 * One pane's caption — its session's one home. Left to right: the role icon,
 * the name (double-click renames it in place), what the session is doing and
 * whether Claude Code waits on the user there, the Restored badge, the ⌘⌥N
 * jump key (on the focused pane, or under the pointer), the session's menu,
 * and, in a split view only, the minus that takes the pane off screen.
 *
 * A pane has no `×`. Leaving the view keeps the session running, and `×`
 * reads as "close" everywhere else: closing lives in the menu, by name.
 */
function PaneCaption({
  workspaceId,
  slot,
  terminalId,
  focused,
  split,
  others,
  onFocus,
  onSwap,
  onLeave,
  onOpenBeside,
}: CaptionProps) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const setup = useTerminalsStore((s) => (terminalId ? s.setupByTerminal[terminalId] : undefined));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuWasOpen = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const refocusName = useRef(false);
  const renameOpenedAt = useRef(0);

  const index = terminals.findIndex((t) => t.id === terminalId);
  const session = index === -1 ? null : terminals[index];
  const Icon = iconForSessionRole(session?.role ?? "shell");
  const jump = index >= 0 && index < 9 ? `⌘⌥${index + 1}` : null;
  const doing = session ? sessionDoing(session, { setup }) : null;
  // Read on every render: the layout and the session list, which decide both
  // answers, re-render the panes whenever either changes.
  const beside = useTerminalsStore.getState().besideAction(workspaceId);
  const replaces = useTerminalsStore.getState().besideReplaces(workspaceId);

  // The pane shows another session: a rename in progress was for the old one.
  useEffect(() => setDraft(null), [terminalId]);

  // A rename ended from the keyboard hands focus back to the name.
  useEffect(() => {
    if (draft !== null || !refocusName.current) return;
    refocusName.current = false;
    nameRef.current?.focus();
  }, [draft]);

  const startRename = () => {
    if (!session) return;
    renameOpenedAt.current = performance.now();
    setDraft(session.label);
  };

  const commit = () => {
    if (draft === null || !session) return;
    const label = draft.trim();
    if (label && label !== session.label) {
      renameTerminal(workspaceId, session.id, label).catch(console.error);
    }
    setDraft(null);
  };

  const menuItem = (run: () => void) => () => {
    setMenu(null);
    run();
  };

  return (
    <div
      data-testid={`run-pane-caption-${slot}`}
      data-tour={slot === 0 ? tourId("run-pane-caption") : undefined}
      data-focused={focused ? "true" : "false"}
      // A press anywhere on the caption focuses its pane; the name is the
      // keyboard's way to do the same. Not a press in its menu, which is a
      // React child of the caption but lives in a portal.
      onClick={(e) => {
        if (e.currentTarget.contains(e.target as Node)) onFocus();
      }}
      className={`octo-rise-in group/caption flex h-8 shrink-0 items-center gap-2 border-b border-octo-hairline bg-octo-panel pl-2.5 pr-1.5 transition-shadow duration-[var(--dur-standard)] ${
        focused ? "shadow-[inset_0_-1px_0_var(--color-octo-border-strong)]" : ""
      }`}
    >
      {session ? (
        <>
          <span title={ROLE_WORD[session.role]} className="flex shrink-0">
            <Icon
              size={13}
              strokeWidth={1.75}
              aria-hidden
              className={`transition-colors duration-[var(--dur-standard)] ${
                focused ? "text-octo-ivory" : "text-octo-mute"
              }`}
            />
          </span>
          <FadeSwap swapKey={session.id} className="flex min-w-0 max-w-[20rem] shrink items-center">
            {draft !== null ? (
              <input
                autoFocus
                aria-label="Session name"
                data-testid={`run-pane-rename-${slot}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  if (performance.now() - renameOpenedAt.current < RENAME_SETTLE_MS) {
                    const input = e.currentTarget;
                    requestAnimationFrame(() => input.isConnected && input.focus());
                    return;
                  }
                  commit();
                }}
                onKeyDown={(e) => {
                  // The name is being typed: no Run shortcut should hear it.
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    refocusName.current = true;
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    refocusName.current = true;
                    setDraft(null);
                  }
                }}
                className="w-[200px] min-w-0 max-w-full rounded border border-octo-border-strong bg-octo-onyx px-1 py-px text-[12px] text-octo-ivory outline-none"
              />
            ) : (
              <button
                ref={nameRef}
                type="button"
                data-testid={`run-pane-name-${slot}`}
                aria-pressed={focused}
                title={`${session.label} · double-click to rename`}
                onDoubleClick={startRename}
                onKeyDown={(e) => {
                  if (e.key !== "F2") return;
                  e.preventDefault();
                  startRename();
                }}
                className={`-ml-[3px] min-w-0 cursor-text truncate rounded-[3px] px-[3px] py-px text-left text-[12px] transition-colors duration-[var(--dur-standard)] hover:bg-[var(--brass-faint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
                  focused ? "text-octo-ivory" : "text-octo-sage"
                }`}
              >
                {session.label}
              </button>
            )}
          </FadeSwap>
          {doing && (
            <span
              data-testid={`run-pane-doing-${slot}`}
              title={doing.text}
              className={`min-w-0 flex-[1_1_6rem] truncate font-mono text-[10px] ${
                doing.tone === "failed"
                  ? "text-octo-rouge"
                  : doing.tone === "live"
                    ? "text-octo-sage"
                    : "text-octo-mute"
              }`}
            >
              {doing.text}
            </span>
          )}
          <PaneWaiting
            compact
            terminalId={terminalId}
            tour={slot === 0 ? tourId("run-pane-waiting") : undefined}
          />
          <FadeSwap swapKey={session.restored ? "restored" : ""} className="flex shrink-0 items-center">
            {session.restored && (
              <span
                data-testid={`run-pane-restored-${slot}`}
                title="Reattached from the previous Octopush run"
                className="font-mono text-[9px] uppercase tracking-[0.15em] text-octo-verdigris"
              >
                Restored
              </span>
            )}
          </FadeSwap>
          {jump && (
            <span
              data-testid={`run-pane-jump-${slot}`}
              title={`Jump to this session from anywhere in Run · ${jump}`}
              className={`shrink-0 font-mono text-[9px] text-octo-mute transition-opacity duration-[var(--dur-quick)] ${
                focused ? "opacity-100" : "opacity-0 group-hover/caption:opacity-100"
              }`}
            >
              {jump}
            </span>
          )}
          <button
            type="button"
            aria-label="Session actions"
            title="Session actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            data-testid={`run-pane-menu-${slot}`}
            // Open beside lives in this menu now: released tours that point
            // at `run-open-beside` land on the button that leads to it.
            data-tour={slot === 0 ? tourId("run-open-beside") : undefined}
            onMouseDown={() => {
              menuWasOpen.current = menu !== null;
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (menuWasOpen.current) {
                menuWasOpen.current = false;
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 224, y: r.bottom + 4 });
            }}
            className={CAPTION_BUTTON}
          >
            <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-octo-mute">Empty seat</span>
      )}
      {split && (
        <button
          type="button"
          aria-label="Leave the view"
          title="Leave the view · the session keeps running"
          data-testid={`run-pane-leave-${slot}`}
          onClick={(e) => {
            e.stopPropagation();
            onLeave();
          }}
          className={CAPTION_BUTTON}
        >
          <Minus size={14} strokeWidth={1.75} aria-hidden />
        </button>
      )}

      {menu && session && (
        <MenuSurface x={menu.x} y={menu.y} ariaLabel="Session actions" onDismiss={() => setMenu(null)}>
          <div className={MENU_HEADER}>{session.label}</div>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={menuItem(startRename)}
          >
            Rename
            <span className={MENU_HINT}>double-click</span>
          </button>
          {beside !== null && (
            <button
              type="button"
              role="menuitem"
              title={
                replaces
                  ? "Choose the session that takes this pane · ⌘D"
                  : "Choose a session to sit beside this one · ⌘D"
              }
              className={MENU_ITEM}
              onClick={menuItem(() => {
                // With no room left the pick replaces the focused pane: this one.
                if (replaces) onFocus();
                onOpenBeside();
              })}
            >
              {replaces ? "Replace in this pane…" : "Open beside…"}
              <span className={MENU_HINT}>⌘D</span>
            </button>
          )}
          {split && others.length > 0 && (
            <>
              <div className={MENU_SEP} />
              <div className={MENU_HEADER}>Swap with…</div>
              {others.map((o) => (
                <button
                  key={o.slot}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={menuItem(() => onSwap(o.slot))}
                >
                  <span className="min-w-0 truncate">{terminals.find((t) => t.id === o.id)?.label}</span>
                </button>
              ))}
            </>
          )}
          {split && (
            <>
              <div className={MENU_SEP} />
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={menuItem(onLeave)}>
                Leave the view
                <span className={MENU_HINT}>keeps running</span>
              </button>
            </>
          )}
          <div className={MENU_SEP} />
          <button
            type="button"
            role="menuitem"
            data-testid={`run-pane-close-${slot}`}
            title="Ends the session and whatever runs in it"
            className={MENU_ITEM_ROUGE}
            onClick={menuItem(() => void deleteTerminal(workspaceId, session.id))}
          >
            Close session
          </button>
        </MenuSurface>
      )}
    </div>
  );
}

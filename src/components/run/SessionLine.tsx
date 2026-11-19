import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, List, Plus } from "lucide-react";
import { RUN_PANES, useTerminalsStore } from "../../stores/terminalsStore";
import {
  PANE_LAYOUT_COUNT,
  choosePaneLayout,
  maxPaneCount,
  paneLayoutOf,
  setOrientation,
  useTerminalLayoutStore,
  type PaneLayout,
} from "../../stores/terminalLayoutStore";
import { useAttentionStore } from "../../stores/attentionStore";
import { useModifierPeek } from "../../hooks/useModifierPeek";
import { iconForSessionRole } from "../../lib/roleIcons";
import { sessionDoing } from "../../lib/sessionDoing";
import { describeSetup } from "../../lib/setupRun";
import { MENU_HEADER, MENU_ITEM, MENU_SEP } from "../../lib/menuStyles";
import { tourId } from "../../lib/tour/ids";
import { MenuSurface } from "../MenuSurface";
import { PaneLayoutIcon } from "../icons/PaneLayoutIcon";

interface Props {
  workspaceId: string;
  /** Opens the ⌘⌥K switcher: the `+N` cell and the narrow line's one button. */
  onOpenSwitcher: () => void;
}

// ─── What fits ────────────────────────────────────────────────────

/** Most session cells the line shows; past it the last one reads `+N`. */
export const MAX_CELLS = 8;

const CELL_PX = 24;
const GAP_PX = 2;
/** The hairline before the layout button: 1px and 6px of air each side. */
const RULE_PX = 13;
/** The `+N` cell (mono, two digits). */
const MORE_PX = 30;
/** The folded line's `N sessions` button (mono, two digits). */
const SESSIONS_PX = 78;

/**
 * The sessions that get a cell, in session order. Up to `capacity` all do;
 * past it the last place is the `+N` cell, so one fewer do, and the focused
 * session keeps a cell even when it sits beyond them (the line must always
 * say where the focus is).
 */
export function visibleSessions(
  ids: readonly string[],
  focusedId: string | null,
  capacity = MAX_CELLS,
): { shown: string[]; more: number } {
  if (ids.length <= capacity) return { shown: [...ids], more: 0 };
  const shown = ids.slice(0, capacity - 1);
  if (focusedId !== null && ids.includes(focusedId) && !shown.includes(focusedId)) {
    shown[shown.length - 1] = focusedId;
  }
  return { shown, more: ids.length - shown.length };
}

/** What the line shows at a given width. */
export interface LinePlan {
  /** Every session's cell, or only the focused session's, or none. */
  cells: "all" | "focused" | "none";
  /** The button that opens ⌘⌥K: `+N` after the cells, or the folded line's
   *  `N sessions`, which becomes a list icon when that is all that fits. */
  counter: "none" | "more" | "sessions" | "list";
  newSession: boolean;
  layout: boolean;
}

/** Atoms laid in a row with the line's gap between them. */
const row = (...atoms: number[]) => atoms.reduce((sum, w) => sum + w, 0) + Math.max(0, atoms.length - 1) * GAP_PX;

/** The line's width with `cells` session cells (and the `+N` cell), beside
 *  its fixed tail: `+`, the hairline and the layout button. */
export function lineWidth(cells: number, hasMore: boolean): number {
  return row(...Array<number>(cells).fill(CELL_PX), ...(hasMore ? [MORE_PX] : []), CELL_PX, RULE_PX, CELL_PX);
}

/**
 * The line on its demotion ladder: it sheds whole atoms, never half of one.
 * While the cells fit they all show. Too narrow, they fold from the left into
 * one `N sessions` button that opens ⌘⌥K, and the focused session's cell,
 * `+` and the layout button stay. A track narrower still (a small window
 * with the rail and the Companion both open) turns the button into a list
 * icon, then gives up the layout button, `+` and the focused cell, in that
 * order: the door to every session is the last thing to go. An unmeasured
 * track (jsdom, a hidden canvas) decides nothing, and the cells stay.
 */
export function planLine(available: number, cells: number, hasMore: boolean): LinePlan {
  if (available <= 0 || lineWidth(cells, hasMore) <= available) {
    return { cells: "all", counter: hasMore ? "more" : "none", newSession: true, layout: true };
  }
  if (row(SESSIONS_PX, CELL_PX, CELL_PX, RULE_PX, CELL_PX) <= available) {
    return { cells: "focused", counter: "sessions", newSession: true, layout: true };
  }
  if (row(CELL_PX, CELL_PX, CELL_PX, RULE_PX, CELL_PX) <= available) {
    return { cells: "focused", counter: "list", newSession: true, layout: true };
  }
  if (row(CELL_PX, CELL_PX, CELL_PX) <= available) {
    return { cells: "focused", counter: "list", newSession: true, layout: false };
  }
  if (row(CELL_PX, CELL_PX) <= available) {
    return { cells: "focused", counter: "list", newSession: false, layout: false };
  }
  return { cells: "none", counter: "list", newSession: false, layout: false };
}

// ─── The instant label ────────────────────────────────────────────

interface Tip {
  id: string;
  /** Viewport coordinates of the label's top-right corner. */
  right: number;
  top: number;
}

/** A pointer crossing the 2px between two cells must not blink the label. */
const TIP_GRACE_MS = 80;
/** `.octo-fade-out`'s duration. */
const TIP_EXIT_MS = 120;

/** The one label under the line: where it is and whether it is fading out. */
function useInstantLabel() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<string | null>(null);

  const show = useCallback((id: string, anchor: HTMLElement) => {
    clearTimeout(timer.current);
    const r = anchor.getBoundingClientRect();
    current.current = id;
    setLeaving(false);
    setTip({ id, right: Math.max(8, window.innerWidth - r.right - 2), top: r.bottom + 5 });
  }, []);

  const hide = useCallback((id: string) => {
    if (current.current !== id) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(() => {
        current.current = null;
        setLeaving(false);
        setTip(null);
      }, TIP_EXIT_MS);
    }, TIP_GRACE_MS);
  }, []);

  /** Fade out now, whatever opened it. */
  const dismiss = useCallback(() => {
    if (current.current === null) return;
    clearTimeout(timer.current);
    setLeaving(true);
    timer.current = setTimeout(() => {
      current.current = null;
      setLeaving(false);
      setTip(null);
    }, TIP_EXIT_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  // A click anywhere ends the reading, as it does for any tooltip — including
  // a click on the cell itself, whose pane is about to answer.
  const open = tip !== null;
  useEffect(() => {
    if (!open) return;
    window.addEventListener("click", dismiss, true);
    return () => window.removeEventListener("click", dismiss, true);
  }, [open, dismiss]);

  return { tip, leaving, show, hide, dismiss };
}

// ─── The line ─────────────────────────────────────────────────────

const LAYOUTS: { value: PaneLayout; label: string; hint?: string }[] = [
  { value: "one", label: "One pane" },
  { value: "two-side", label: "Two, side by side", hint: "⌘D" },
  { value: "two-stacked", label: "Two, stacked" },
  { value: "three", label: "Three" },
  { value: "four", label: "Four" },
];

/** A 24px control of the line that is not a session: `+`, the layout button. */
const CONTROL =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors duration-[var(--dur-quick)] hover:bg-octo-panel hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

/** The buttons that stand for sessions without a cell: `+N`, `N sessions`. */
const COUNTER =
  "octo-fade-in relative flex h-6 min-w-6 shrink-0 items-center justify-center whitespace-nowrap rounded px-1.5 font-mono text-[10px] text-octo-mute transition-colors duration-[var(--dur-quick)] hover:bg-octo-panel hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

/**
 * Run's session line — the mode band's right track, turned into the
 * navigation for open terminals (it replaced the 44px rail on the canvas's
 * left and the band's one-session anchor).
 *
 * One 24px cell per session, in session order. Each fact has one channel:
 *
 *  - **the icon** is the session's role (`iconForSessionRole`), and flips to
 *    its ⌘⌥N number while ⌥ is held;
 *  - **the icon's ink** is presence: ivory in a pane, mute off screen;
 *  - **the underline's colour** is focus (brass: the focused pane's session,
 *    the line's only brass besides attention);
 *  - **the underline's motion** is work: it marches while a command runs —
 *    sage, or brass on the focused session;
 *  - **a static brass dot** is a session that rang or waits on the user while
 *    it isn't the one in focus.
 *
 * Hover or keyboard focus puts an instant label under a cell — name, what it
 * is doing, its jump key — with no actions: a session's actions live on its
 * pane's caption. After the cells: `+`, a hairline, and the layout button.
 */
export function SessionLine({ workspaceId, onOpenSwitcher }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const focusedId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const setActive = useTerminalsStore((s) => s.setActive);
  const openBeside = useTerminalsStore((s) => s.openBeside);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const updateLayout = useTerminalsStore((s) => s.updateLayout);
  const setupByTerminal = useTerminalsStore((s) => s.setupByTerminal);
  const layout = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  const split = useTerminalLayoutStore((s) => s.splitByWs[workspaceId]);
  const flag = useAttentionStore((s) => s.flagsByWs[workspaceId]);
  // Hook waits are per session, so every blocked cell is marked, not only the
  // one that pinged last.
  const waits = useAttentionStore((s) => s.waitsByTerminal);
  const peek = useModifierPeek();
  const label = useInstantLabel();

  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // A press on the layout button while its menu is open closes it (the menu's
  // outside-press does); the click that follows must not open it again.
  const menuWasOpen = useRef(false);
  // A cell focused by a press is being clicked, not read: only keyboard focus
  // opens the label, and a label the keyboard opened outlives the pointer.
  const pressed = useRef(false);
  const keyboardId = useRef<string | null>(null);

  // The track's width is set by the band's grid, never by this content, so
  // folding the cells can't feed back into the measurement. The root's 1px
  // padding (room for a focus ring inside its clip) is not room for cells.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setAvailable(Math.max(0, el.clientWidth - 2));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shownIds = layout?.slots ?? [focusedId];
  const ringingId = flag?.kind === "terminal" ? (flag.terminalId ?? null) : null;
  /** Rang, or Claude Code waits, in a session that isn't the one in focus. */
  const marked = (id: string) => id !== focusedId && (!!waits[id] || ringingId === id);

  const ids = terminals.map((t) => t.id);
  const all = visibleSessions(ids, focusedId);
  const plan = planLine(available, all.shown.length, all.more > 0);
  const folded = plan.cells !== "all";
  const cellIds =
    plan.cells === "all" ? all.shown : plan.cells === "focused" ? all.shown.filter((id) => id === focusedId) : [];
  const cells = terminals.filter((t) => cellIds.includes(t.id));
  const uncelled = terminals.filter((t) => !cellIds.includes(t.id));
  const uncelledMarked = uncelled.some((t) => marked(t.id));
  // The tour points at the first marked waiting session, wherever it shows.
  const firstWaitingId = terminals.find((t) => waits[t.id] && t.id !== focusedId)?.id ?? null;
  const waitingTourOnCounter = firstWaitingId !== null && !cellIds.includes(firstWaitingId);
  // One tab stop for the whole line: the focused session's cell, else the
  // first control there is. Arrow keys travel from there.
  const stopId = cells.some((t) => t.id === focusedId) ? focusedId : (cells[0]?.id ?? null);
  const stopsOnCounter = stopId === null && plan.counter !== "none";
  const stopsOnNew = stopId === null && !stopsOnCounter;

  const count = layout?.slots.length ?? 1;
  const orientation = split ?? (layout?.orientation === "stacked" ? "stacked" : "side");
  const current = paneLayoutOf(count, orientation);
  const reachable = maxPaneCount(terminals.length, RUN_PANES);
  const automatic = (layout?.orientation ?? "auto") === "auto";

  /** Click: focus the session's pane, or show it in the focused one.
   *  ⌥-click: open it beside (a new pane up to four, then the focused one). */
  const activate = (id: string, beside: boolean) => {
    if (beside) openBeside(workspaceId, id);
    else setActive(workspaceId, id);
  };

  /** Roving focus across every control of the line. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-line-stop]");
    if (!from || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-line-stop]"));
    const at = stops.indexOf(from);
    if (at === -1) return;
    e.preventDefault();
    const to =
      e.key === "ArrowLeft"
        ? Math.max(0, at - 1)
        : e.key === "ArrowRight"
          ? Math.min(stops.length - 1, at + 1)
          : e.key === "Home"
            ? 0
            : stops.length - 1;
    stops[to]?.focus();
  };

  /** What a cell's session is doing: the label's words, and the cell's name.
   *  A session that rang says so, since its dot alone is only a colour. */
  const doingOf = (t: (typeof terminals)[number]) => {
    const wait = waits[t.id];
    const doing = sessionDoing(t, { wait: wait?.reason, setup: setupByTerminal[t.id] }).text;
    return !wait && ringingId === t.id && t.id !== focusedId ? `${doing} · rang` : doing;
  };

  // The label is measured once, against its cell: when the line may have
  // moved under it (the panes changed and the Companion folded, the band
  // resized, another session took the focus), it goes rather than point at
  // where the cell used to be.
  const dismissLabel = label.dismiss;
  useEffect(() => dismissLabel(), [dismissLabel, count, available, focusedId]);

  // A cell that left the line under the pointer never reports the pointer
  // leaving, so the label goes with its cell.
  const tipSession = label.tip ? cells.find((t) => t.id === label.tip?.id) : undefined;
  const tipIndex = tipSession ? ids.indexOf(tipSession.id) : -1;

  const counter = (text: string | null, name: string, title: string) => (
    <button
      type="button"
      data-line-stop
      tabIndex={stopsOnCounter ? 0 : -1}
      data-testid="session-more"
      aria-label={uncelledMarked ? `${name} — a session needs you` : name}
      title={title}
      onClick={onOpenSwitcher}
      className={COUNTER}
    >
      {text === null ? (
        <List size={13} strokeWidth={1.75} aria-hidden />
      ) : (
        <span className="octo-tabular">{text}</span>
      )}
      {uncelledMarked && (
        <span
          aria-hidden
          data-testid="session-more-bell"
          data-tour={waitingTourOnCounter ? tourId("run-session-waiting") : undefined}
          className="octo-pop-in pointer-events-none absolute right-0 top-0.5 h-[5px] w-[5px] rounded-full bg-octo-brass"
        />
      )}
    </button>
  );

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Sessions and layout"
      data-tour={tourId("run-session-line")}
      data-testid="session-line"
      data-folded={folded ? "true" : "false"}
      onKeyDown={onKeyDown}
      // Clipped, so a track too narrow for even one control shows nothing
      // rather than drawing over the mode switcher; the 1px padding (and the
      // margin that takes it back) keeps focus rings inside the clip.
      className="-m-px flex min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden p-px"
    >
      {(plan.counter === "sessions" || plan.counter === "list") &&
        counter(
          plan.counter === "sessions" ? `${terminals.length} sessions` : null,
          `All ${terminals.length} sessions`,
          `All ${terminals.length} sessions · ⌘⌥K`,
        )}

      <div
        role="tablist"
        aria-label="Terminal sessions"
        aria-orientation="horizontal"
        className="flex shrink-0 items-center gap-[2px]"
      >
        {cells.map((t) => {
          const i = ids.indexOf(t.id);
          const focused = t.id === focusedId;
          const shown = shownIds.includes(t.id);
          const Icon = iconForSessionRole(t.role);
          const jump = i < 9 ? `⌘⌥${i + 1}` : null;
          const setup = setupByTerminal[t.id];
          const wait = waits[t.id];
          const name = `${t.label} — ${doingOf(t)}${jump ? ` · ${jump}` : ""}`;

          return (
            <div
              key={t.id}
              role="presentation"
              data-tour={setup ? tourId("run-setup-session") : undefined}
              className="octo-fade-in relative h-6 w-6 shrink-0"
              onPointerDown={() => {
                pressed.current = true;
              }}
              onMouseEnter={(e) => label.show(t.id, e.currentTarget)}
              onMouseLeave={() => {
                if (keyboardId.current !== t.id) label.hide(t.id);
              }}
            >
              <button
                type="button"
                role="tab"
                data-line-stop
                aria-selected={focused}
                aria-current={shown ? "true" : undefined}
                tabIndex={t.id === stopId ? 0 : -1}
                data-testid={`session-cell-${t.id}`}
                data-shown={shown ? "true" : "false"}
                // The demo hovers the focused session's cell for its label.
                data-tour={focused ? tourId("run-session-cell") : undefined}
                // No native `title`: the instant label opens on the same hover
                // (and on keyboard focus) with the same text, and it is
                // `aria-hidden` because this name already says it.
                aria-label={name}
                onClick={(e) => {
                  pressed.current = false;
                  activate(t.id, e.altKey);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  activate(t.id, e.altKey);
                }}
                onFocus={(e) => {
                  if (pressed.current) {
                    pressed.current = false;
                    return;
                  }
                  keyboardId.current = t.id;
                  label.show(t.id, e.currentTarget);
                }}
                onBlur={() => {
                  if (keyboardId.current === t.id) keyboardId.current = null;
                  label.hide(t.id);
                }}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors duration-[var(--dur-quick)] hover:bg-octo-panel hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
                  shown ? "text-octo-ivory" : "text-octo-mute"
                }`}
              >
                {peek && i < 9 ? (
                  <span className="octo-tabular font-mono text-[10px]">{i + 1}</span>
                ) : (
                  <Icon size={13} strokeWidth={1.75} aria-hidden />
                )}
              </button>

              {/* The underline — a reserved 2px slot, so no state shifts the
                  icon. Its colour is focus, its motion is work: the two never
                  compete, and a busy session never turns its icon brass. */}
              <span
                aria-hidden
                data-testid={`session-underline-${t.id}`}
                data-focus={focused ? "true" : "false"}
                data-busy={t.busy ? "true" : "false"}
                // Classes, not inline styles: the colour is a token either way.
                className={`pointer-events-none absolute bottom-px left-[5px] right-[5px] h-0.5 rounded-[1px] ${
                  t.busy
                    ? `rail-bar-running-x ${
                        focused ? "[--rail-bar:var(--color-octo-brass)]" : "[--rail-bar:var(--color-octo-sage)]"
                      }`
                    : `transition-colors duration-[var(--dur-quick)] ${focused ? "bg-octo-brass" : "bg-transparent"}`
                }`}
              />

              {/* Rang, or waiting, while it isn't in focus. Static, not
                  pulsing: inside Run the mode switcher's pulse has already
                  handed off, and one attention scope gets one pulse. */}
              {marked(t.id) && (
                <span
                  data-testid={`session-bell-${t.id}`}
                  data-tour={t.id === firstWaitingId ? tourId("run-session-waiting") : undefined}
                  className="octo-pop-in pointer-events-none absolute right-0.5 top-0.5 h-[5px] w-[5px] rounded-full bg-octo-brass"
                  title={
                    wait
                      ? "Claude Code is waiting on you in this session"
                      : "This session rang while you were elsewhere"
                  }
                />
              )}

              {/* A failed setup script: static rouge, the workspace still works. */}
              {setup?.status === "failed" && (
                <span
                  data-testid={`session-setup-failed-${t.id}`}
                  className="octo-pop-in pointer-events-none absolute left-0.5 top-0.5 h-[5px] w-[5px] rounded-full bg-octo-rouge"
                  title={describeSetup(setup)}
                />
              )}
            </div>
          );
        })}
      </div>

      {plan.counter === "more" &&
        counter(`+${all.more}`, `${all.more} more sessions`, `${all.more} more sessions · ⌘⌥K`)}

      {plan.newSession && (
        <button
          type="button"
          data-line-stop
          tabIndex={stopsOnNew ? 0 : -1}
          data-testid="session-new"
          aria-label="Open a new session"
          title="Open a new session"
          onClick={() => createTerminal(workspaceId).catch(console.error)}
          className={CONTROL}
        >
          <Plus size={13} strokeWidth={1.75} aria-hidden />
        </button>
      )}

      {plan.layout && <span aria-hidden className="mx-1.5 h-3.5 w-px shrink-0 bg-octo-hairline" />}

      {plan.layout && (
        <button
          type="button"
          data-line-stop
          tabIndex={-1}
          data-testid="session-layout"
          data-tour={tourId("run-layout")}
          aria-label="Layout"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          title={`Layout · ${count} ${count === 1 ? "pane" : "panes"}`}
          onMouseDown={() => {
            menuWasOpen.current = menu !== null;
          }}
          onClick={(e) => {
            if (menuWasOpen.current) {
              menuWasOpen.current = false;
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            // Right-aligned under the button; the menu clamps to the viewport.
            setMenu({ x: r.right - 224, y: r.bottom + 6 });
          }}
          className={CONTROL}
        >
          <PaneLayoutIcon layout={current} orientation={orientation} />
        </button>
      )}

      {menu && (
        <MenuSurface x={menu.x} y={menu.y} ariaLabel="Layout" onDismiss={() => setMenu(null)}>
          <div className={MENU_HEADER}>Layout</div>
          {LAYOUTS.map((l) => {
            const checked = l.value === current;
            const short = PANE_LAYOUT_COUNT[l.value] > reachable;
            return (
              <button
                key={l.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                disabled={short}
                title={short ? "Open another session to fill this layout" : undefined}
                data-testid={`session-layout-${l.value}`}
                data-tour={l.value === "two-side" ? tourId("run-layout-two") : undefined}
                className={`${MENU_ITEM} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-octo-sage`}
                onClick={() => {
                  setMenu(null);
                  updateLayout(workspaceId, (prev) => choosePaneLayout(prev, l.value, ids, RUN_PANES));
                }}
              >
                {/* The checked item's Check, in a fixed 14px icon column. */}
                <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                  {checked && <Check size={13} strokeWidth={1.75} />}
                </span>
                <PaneLayoutIcon layout={l.value} orientation={orientation} className="shrink-0" />
                {l.label}
                {l.hint && <span className="ml-auto text-[10px] text-octo-mute">{l.hint}</span>}
              </button>
            );
          })}
          {(count === 2 || count === 3) && (
            <>
              <div className={MENU_SEP} />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={automatic}
                data-testid="session-layout-auto"
                title="Side by side while every pane keeps 72 columns, stacked below that"
                className={MENU_ITEM}
                onClick={() => {
                  setMenu(null);
                  // Unchecking pins the orientation on screen.
                  updateLayout(workspaceId, (prev) => setOrientation(prev, automatic ? orientation : "auto"));
                }}
              >
                <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                  {automatic && <Check size={13} strokeWidth={1.75} />}
                </span>
                Automatic orientation
              </button>
            </>
          )}
          <div className={MENU_SEP} />
          <p className="px-3 pb-1 pt-2 font-mono text-[10px] leading-[1.5] text-octo-mute">
            Fills new panes with the next sessions not on screen.
          </p>
        </MenuSurface>
      )}

      {label.tip &&
        tipSession &&
        createPortal(
          <div
            aria-hidden
            data-testid="session-label"
            className={`${label.leaving ? "octo-fade-out" : "octo-fade-in"} pointer-events-none fixed z-[60] flex max-w-[min(420px,calc(100vw-16px))] items-baseline gap-2 whitespace-nowrap rounded-[5px] border border-octo-hairline bg-octo-panel-2 px-2 py-1`}
            style={{ right: label.tip.right, top: label.tip.top }}
          >
            <span className="max-w-[16rem] shrink-0 truncate text-[12px] text-octo-ivory">
              {tipSession.label}
            </span>
            <span className="min-w-0 truncate font-mono text-[10px] text-octo-mute">{doingOf(tipSession)}</span>
            {tipIndex < 9 && (
              <span className="shrink-0 font-mono text-[10px] text-octo-mute">· ⌘⌥{tipIndex + 1}</span>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

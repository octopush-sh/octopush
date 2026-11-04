import { create } from "zustand";

// Which sessions Run puts on screen, per workspace
// (docs/superpowers/specs/2026-11-03-run-session-pair-design.md). The reducers
// below are pure; `terminalsStore.updateLayout` is the one path that commits a
// layout, so `activeByWs` (the focused slot's session) can never drift from it.
// Run and Talk layouts persist in localStorage; deleted sessions are pruned on
// load (`terminalsStore.loadTerminals`) and on delete (`forget`).

/** Most panes Run shows at once (a 2×2 grid). */
export const MAX_SLOTS = 4;
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;

export type Orientation = "auto" | "side" | "stacked";

export interface RunLayout {
  /** Reading order. `null` is an empty seat (or, alone, no session yet). */
  slots: (string | null)[];
  orientation: Orientation;
  /** One fraction per divider: none for 1 pane, `[split]` for 2,
   *  `[mainSplit, sideSplit]` for 3, `[colSplit, rowSplit]` for 4. */
  ratios: number[];
  /** Index of the focused slot. */
  focused: number;
}

export const EMPTY_RUN_LAYOUT: RunLayout = {
  slots: [null],
  orientation: "auto",
  ratios: [],
  focused: 0,
};

/** Even dividers for `count` panes. */
export function evenRatios(count: number): number[] {
  return count <= 1 ? [] : count === 2 ? [0.5] : [0.5, 0.5];
}

/** The session in the focused slot, or null. */
export function focusedId(layout: RunLayout): string | null {
  return layout.slots[layout.focused] ?? null;
}

/** A layout with `slots`, keeping the dividers when the count didn't change. */
function withSlots(layout: RunLayout, slots: (string | null)[], focused: number): RunLayout {
  const ratios = slots.length === layout.slots.length ? layout.ratios : evenRatios(slots.length);
  return { ...layout, slots, ratios, focused: clampIndex(focused, slots.length) };
}

function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(length - 1, i));
}

/** Focus a slot. Focus never moves a session between slots. */
export function focus(layout: RunLayout, slot: number): RunLayout {
  const focused = clampIndex(slot, layout.slots.length);
  return focused === layout.focused ? layout : { ...layout, focused };
}

/**
 * Put `id` in `slot` and focus it. `slot === slots.length` appends a new slot
 * (up to four). A session already on screen is only focused where it is: a
 * session is in at most one slot.
 */
export function assign(layout: RunLayout, slot: number, id: string | null): RunLayout {
  if (id !== null) {
    const at = layout.slots.indexOf(id);
    if (at !== -1) return focus(layout, at);
  }
  if (slot === layout.slots.length) {
    if (slot >= MAX_SLOTS) return layout;
    return withSlots(layout, [...layout.slots, id], slot);
  }
  if (slot < 0 || slot > layout.slots.length) return layout;
  const slots = layout.slots.slice();
  slots[slot] = id;
  return withSlots(layout, slots, slot);
}

/** True when Open beside has no seat and no room left (`max` panes, none
 *  empty): a pick then replaces the session in the focused pane. */
export function besideReplaces(layout: RunLayout, max = MAX_SLOTS): boolean {
  return !layout.slots.includes(null) && layout.slots.length >= max;
}

/** The slot Open beside fills: the first empty seat, else a new slot at the
 *  end, else (no room) the focused pane. */
export function besideSlot(layout: RunLayout, max = MAX_SLOTS): number {
  const seat = layout.slots.indexOf(null);
  if (seat !== -1) return seat;
  return besideReplaces(layout, max) ? layout.focused : layout.slots.length;
}

/**
 * What Open beside does now: `"pair"` opens the pairing switcher, `"seat"`
 * appends an empty seat (every session is already on screen), null nothing
 * (no session on screen yet, or no room and nothing to bring in).
 * `hasHidden` is whether any session is not on screen.
 */
export function besideAction(
  layout: RunLayout,
  hasHidden: boolean,
  max = MAX_SLOTS,
): "pair" | "seat" | null {
  if (layout.slots.every((id) => id === null)) return null;
  if (hasHidden || layout.slots.includes(null)) return "pair";
  return layout.slots.length < max ? "seat" : null;
}

/**
 * Open beside: `id` goes in the first empty seat, else a new slot at the end;
 * with `max` panes and no empty seat it replaces the focused pane. `null` adds
 * an empty seat (at most one, never past `max`) and keeps focus.
 */
export function openBeside(layout: RunLayout, id: string | null, max = MAX_SLOTS): RunLayout {
  const seat = layout.slots.indexOf(null);
  if (id === null) {
    if (seat !== -1 || layout.slots.length >= max) return layout;
    return withSlots(layout, [...layout.slots, null], layout.focused);
  }
  if (layout.slots.includes(id)) return assign(layout, layout.slots.indexOf(id), id);
  return assign(layout, besideSlot(layout, max), id);
}

/**
 * Remove a slot; the ones after it shift down. A focused slot hands focus to
 * the next pane in reading order. The last slot empties instead of going.
 */
export function leave(layout: RunLayout, slot: number): RunLayout {
  if (slot < 0 || slot >= layout.slots.length) return layout;
  if (layout.slots.length === 1) return withSlots(layout, [null], 0);
  const slots = layout.slots.filter((_, i) => i !== slot);
  const focused =
    layout.focused > slot
      ? layout.focused - 1
      : layout.focused === slot && slot >= slots.length
        ? 0
        : layout.focused;
  return withSlots(layout, slots, focused);
}

/**
 * The user leaving a pane (`×`, *Leave the view*). Like `leave`, except that
 * leaving a session beside nothing but empty seats drops the seats instead:
 * the view returns to one pane showing that session, never to a blank Run
 * while the session still exists. (`prune` keeps using `leave`.)
 */
export function leaveView(layout: RunLayout, slot: number): RunLayout {
  const id = layout.slots[slot];
  const next = leave(layout, slot);
  if (id != null && next.slots.every((s) => s === null)) return withSlots(layout, [id], 0);
  return next;
}

/** Swap two slots' sessions. Focus stays with the session that had it. */
export function swap(layout: RunLayout, a: number, b: number): RunLayout {
  const n = layout.slots.length;
  if (a === b || a < 0 || b < 0 || a >= n || b >= n) return layout;
  const slots = layout.slots.slice();
  [slots[a], slots[b]] = [slots[b], slots[a]];
  const focused = layout.focused === a ? b : layout.focused === b ? a : layout.focused;
  return { ...layout, slots, focused };
}

export function setOrientation(layout: RunLayout, orientation: Orientation): RunLayout {
  return orientation === layout.orientation ? layout : { ...layout, orientation };
}

/** Set the dividers, each clamped to 0.2–0.8. A list of the wrong length for
 *  the pane count is ignored. */
export function setRatios(layout: RunLayout, ratios: number[]): RunLayout {
  if (ratios.length !== evenRatios(layout.slots.length).length) return layout;
  if (ratios.some((r) => !Number.isFinite(r))) return layout;
  return { ...layout, ratios: ratios.map((r) => Math.max(RATIO_MIN, Math.min(RATIO_MAX, r))) };
}

// ─── Geometry ─────────────────────────────────────────────────────

/** Narrowest pane, in terminal columns, that `auto` still puts side by side. */
export const MIN_SIDE_COLUMNS = 72;

/** A divider: the line at `at` across `axis` (`"x"` splits left from right),
 *  spanning `from`–`to` of the other axis, set by `ratios[ratio]`. */
export interface Divider {
  ratio: number;
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/**
 * Where `auto` lands for this layout `width` pixels wide with `cellWidth`-pixel
 * columns: side by side when every pane of an EVEN side-by-side layout for the
 * current count would keep 72 columns, else stacked. The dividers never enter
 * into it, so dragging or evening one never changes the orientation; only the
 * width and the pane count do. An override wins; one and four panes have no
 * choice (four are always a 2×2 grid), so they report `"side"`. An unmeasured
 * width stays side by side.
 */
export function resolveOrientation(layout: RunLayout, width: number, cellWidth: number): "side" | "stacked" {
  const count = layout.slots.length;
  if (count !== 2 && count !== 3) return "side";
  if (layout.orientation !== "auto") return layout.orientation;
  if (width <= 0 || cellWidth <= 0) return "side";
  // Even, two panes are halves; three are a half beside a stacked pair, so
  // the narrowest pane is half the width either way.
  const split = evenRatios(count)[0];
  const narrowest = width * Math.min(split, 1 - split);
  return narrowest / cellWidth >= MIN_SIDE_COLUMNS ? "side" : "stacked";
}

/** A slot's place in `paneGrid`: 1-based grid lines, `[start, end]`. */
export interface GridArea {
  column: [number, number];
  row: [number, number];
}

/**
 * The slots and dividers for `count` panes (spec "Slots and layout") as one
 * 2×2 grid: two column and two row tracks in `fr` (each pair sums to 1), each
 * slot's area and the dividers. Three panes: slot 0 is the large pane, the
 * main divider between it and the pair, the side divider between the pair.
 * Four: one shared cross. Every layout uses two tracks per axis, an unused one
 * at `0fr`, so a change between any two interpolates the tracks: the
 * grid-rows `0fr↔1fr` idiom (spec "Motion").
 */
export function paneGrid(
  count: number,
  orientation: "side" | "stacked",
  ratios: number[],
): { columns: [number, number]; rows: [number, number]; areas: GridArea[]; dividers: Divider[] } {
  const a = ratios[0] ?? 0.5;
  const b = ratios[1] ?? 0.5;
  const at = (c0: number, c1: number, r0: number, r1: number): GridArea => ({ column: [c0, c1], row: [r0, r1] });
  const main = orientation === "side" ? "x" : "y";
  const cross = main === "x" ? "y" : "x";
  if (count <= 1) return { columns: [1, 0], rows: [1, 0], areas: [at(1, 3, 1, 3)], dividers: [] };
  const first: Divider = { ratio: 0, axis: count === 4 ? "x" : main, at: a, from: 0, to: 1 };
  if (count === 2) {
    const dividers: Divider[] = [first];
    return orientation === "side"
      ? { columns: [a, 1 - a], rows: [1, 0], areas: [at(1, 2, 1, 3), at(2, 3, 1, 3)], dividers }
      : { columns: [1, 0], rows: [a, 1 - a], areas: [at(1, 3, 1, 2), at(1, 3, 2, 3)], dividers };
  }
  if (count === 3) {
    const dividers: Divider[] = [first, { ratio: 1, axis: cross, at: b, from: a, to: 1 }];
    return orientation === "side"
      ? { columns: [a, 1 - a], rows: [b, 1 - b], areas: [at(1, 2, 1, 3), at(2, 3, 1, 2), at(2, 3, 2, 3)], dividers }
      : { columns: [b, 1 - b], rows: [a, 1 - a], areas: [at(1, 3, 1, 2), at(1, 2, 2, 3), at(2, 3, 2, 3)], dividers };
  }
  return {
    columns: [a, 1 - a],
    rows: [b, 1 - b],
    areas: [at(1, 2, 1, 2), at(2, 3, 1, 2), at(1, 2, 2, 3), at(2, 3, 2, 3)],
    dividers: [first, { ratio: 1, axis: "y", at: b, from: 0, to: 1 }],
  };
}

/** Drop every slot whose session no longer exists, exactly as leaving it. */
export function prune(layout: RunLayout, exists: (id: string) => boolean): RunLayout {
  let next = layout;
  for (let i = next.slots.length - 1; i >= 0; i--) {
    const id = next.slots[i];
    if (id !== null && !exists(id)) next = leave(next, i);
  }
  return next;
}

/** `id` first, then the rest of `mru` without it. */
export function touchMru(mru: string[], id: string): string[] {
  return mru[0] === id ? mru : [id, ...mru.filter((x) => x !== id)];
}

// ─── Talk's seat ──────────────────────────────────────────────────

/** Talk's one terminal beside the conversation. It has no focus of its own
 *  in Run's sense: nothing here ever changes `activeByWs`. */
export interface TalkSeat {
  /** The session in the seat, or null (an empty seat). */
  terminalId: string | null;
  /** The seat's share of the canvas width, 0.2–0.8. */
  width: number;
  open: boolean;
}

export const EMPTY_TALK_SEAT: TalkSeat = { terminalId: null, width: 0.5, open: false };

const clampRatio = (r: number) => Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));

/** Open the seat, or close it. Closing keeps its session for next time. */
export function toggleTalk(seat: TalkSeat): TalkSeat {
  return { ...seat, open: !seat.open };
}

/** Put `id` in the seat and open it. */
export function seatTalk(seat: TalkSeat, id: string | null): TalkSeat {
  return seat.open && seat.terminalId === id ? seat : { ...seat, terminalId: id, open: true };
}

export function setTalkWidth(seat: TalkSeat, width: number): TalkSeat {
  return Number.isFinite(width) ? { ...seat, width: clampRatio(width) } : seat;
}

/** Empty the seat when its session no longer exists. */
export function pruneTalk(seat: TalkSeat, exists: (id: string) => boolean): TalkSeat {
  return seat.terminalId !== null && !exists(seat.terminalId) ? { ...seat, terminalId: null } : seat;
}

// ─── Persistence ──────────────────────────────────────────────────

export const LAYOUTS_KEY = "octopush.terminalLayouts";

interface Persisted {
  run: Record<string, RunLayout>;
  talk: Record<string, TalkSeat>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored Run layout, or null when it isn't one (a session twice, a bad
 *  count): a layout that breaks the one-pane-per-session rule is dropped. */
function readRun(v: unknown): RunLayout | null {
  if (!isRecord(v) || !Array.isArray(v.slots)) return null;
  const slots = v.slots as unknown[];
  if (slots.length < 1 || slots.length > MAX_SLOTS) return null;
  if (!slots.every((s) => s === null || typeof s === "string")) return null;
  const ids = slots.filter((s) => s !== null);
  // At most one empty seat.
  if (new Set(ids).size !== ids.length || slots.length - ids.length > 1) return null;
  const orientation: Orientation =
    v.orientation === "side" || v.orientation === "stacked" ? v.orientation : "auto";
  const base: RunLayout = {
    slots: slots as (string | null)[],
    orientation,
    ratios: evenRatios(slots.length),
    focused: clampIndex(Number.isInteger(v.focused) ? (v.focused as number) : 0, slots.length),
  };
  return Array.isArray(v.ratios) ? setRatios(base, v.ratios as number[]) : base;
}

function readTalk(v: unknown): TalkSeat | null {
  if (!isRecord(v)) return null;
  return setTalkWidth(
    {
      terminalId: typeof v.terminalId === "string" ? v.terminalId : null,
      width: EMPTY_TALK_SEAT.width,
      open: v.open === true,
    },
    typeof v.width === "number" ? v.width : EMPTY_TALK_SEAT.width,
  );
}

/** The layouts in a stored value, keeping only the well-formed ones. Pure. */
export function readLayouts(raw: unknown): Persisted {
  const out: Persisted = { run: {}, talk: {} };
  if (!isRecord(raw)) return out;
  for (const [key, read] of [["run", readRun], ["talk", readTalk]] as const) {
    const byWs = raw[key];
    if (!isRecord(byWs)) continue;
    for (const [ws, v] of Object.entries(byWs)) {
      const layout = read(v);
      if (layout) (out[key] as Record<string, unknown>)[ws] = layout;
    }
  }
  return out;
}

function loadLayouts(): Persisted {
  try {
    return readLayouts(JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? "null"));
  } catch {
    return { run: {}, talk: {} };
  }
}

function saveLayouts(layouts: Persisted) {
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(layouts));
  } catch (err) {
    console.error("Failed to persist terminal layouts:", err);
  }
}

// ─── Store ────────────────────────────────────────────────────────

const EMPTY_MRU: string[] = [];
const stored = loadLayouts();

interface TerminalLayoutStore {
  runByWs: Record<string, RunLayout>;
  /** Sessions most recently focused first, per workspace. */
  mruByWs: Record<string, string[]>;
  /** True while a divider is being dragged: panes refit on animation frames
   *  and only tell the PTY their size on pointer-up. */
  resizing: boolean;

  getRun: (workspaceId: string) => RunLayout;
  getMru: (workspaceId: string) => string[];
  /** The most recently used session that is not on screen. */
  recentNotShown: (workspaceId: string, exists: (id: string) => boolean) => string | null;
  /** Commit a layout. Called only by `terminalsStore.updateLayout`. */
  commitRun: (workspaceId: string, layout: RunLayout) => void;
  /** Forget a deleted session: its MRU entry, and Talk's seat if it held it. */
  forget: (workspaceId: string, id: string) => void;
  /** Forget a deleted workspace's layouts and MRU. */
  forgetWorkspace: (workspaceId: string) => void;
  setResizing: (resizing: boolean) => void;

  talkByWs: Record<string, TalkSeat>;
  /** True while Talk's seat holds keyboard focus (the user clicked into it or
   *  just picked its session); the conversation taking focus clears it.
   *  Separate from Run's focused slot, and never written to `activeByWs`. */
  talkFocused: boolean;
  getTalk: (workspaceId: string) => TalkSeat;
  updateTalk: (workspaceId: string, fn: (seat: TalkSeat) => TalkSeat) => void;
  /** Put `id` in Talk's seat, open it and give it keyboard focus. */
  seatTalkSession: (workspaceId: string, id: string) => void;
  setTalkFocused: (focused: boolean) => void;
}

export const useTerminalLayoutStore = create<TerminalLayoutStore>((set, get) => ({
  runByWs: stored.run,
  mruByWs: {},
  resizing: false,
  talkByWs: stored.talk,
  talkFocused: false,

  getRun: (workspaceId) => get().runByWs[workspaceId] ?? EMPTY_RUN_LAYOUT,

  getTalk: (workspaceId) => get().talkByWs[workspaceId] ?? EMPTY_TALK_SEAT,

  updateTalk: (workspaceId, fn) =>
    set((s) => {
      const prev = s.talkByWs[workspaceId] ?? EMPTY_TALK_SEAT;
      const next = fn(prev);
      return next === prev ? s : { talkByWs: { ...s.talkByWs, [workspaceId]: next } };
    }),

  seatTalkSession: (workspaceId, id) => {
    get().updateTalk(workspaceId, (seat) => seatTalk(seat, id));
    get().setTalkFocused(true);
  },

  setTalkFocused: (talkFocused) => set((s) => (s.talkFocused === talkFocused ? s : { talkFocused })),

  getMru: (workspaceId) => get().mruByWs[workspaceId] ?? EMPTY_MRU,

  recentNotShown: (workspaceId, exists) => {
    const shown = get().getRun(workspaceId).slots;
    return get().getMru(workspaceId).find((id) => exists(id) && !shown.includes(id)) ?? null;
  },

  commitRun: (workspaceId, layout) =>
    set((s) => {
      const id = focusedId(layout);
      const mru = s.mruByWs[workspaceId] ?? EMPTY_MRU;
      const nextMru = id === null ? mru : touchMru(mru, id);
      if (s.runByWs[workspaceId] === layout && nextMru === mru) return s;
      return {
        runByWs: { ...s.runByWs, [workspaceId]: layout },
        mruByWs: nextMru === mru ? s.mruByWs : { ...s.mruByWs, [workspaceId]: nextMru },
      };
    }),

  forget: (workspaceId, id) => {
    set((s) => {
      const mru = s.mruByWs[workspaceId];
      if (!mru?.includes(id)) return s;
      return { mruByWs: { ...s.mruByWs, [workspaceId]: mru.filter((x) => x !== id) } };
    });
    get().updateTalk(workspaceId, (seat) => pruneTalk(seat, (x) => x !== id));
  },

  forgetWorkspace: (workspaceId) =>
    set((s) => {
      const { [workspaceId]: _run, ...runByWs } = s.runByWs;
      const { [workspaceId]: _mru, ...mruByWs } = s.mruByWs;
      const { [workspaceId]: _talk, ...talkByWs } = s.talkByWs;
      return { runByWs, mruByWs, talkByWs };
    }),

  setResizing: (resizing) => set((s) => (s.resizing === resizing ? s : { resizing })),
}));

// Every layout change is written through: a restart reopens the same panes.
useTerminalLayoutStore.subscribe((s, prev) => {
  if (s.runByWs !== prev.runByWs || s.talkByWs !== prev.talkByWs) {
    saveLayouts({ run: s.runByWs, talk: s.talkByWs });
  }
});

import { create } from "zustand";

// Which sessions Run puts on screen, per workspace
// (docs/superpowers/specs/2026-11-03-run-session-pair-design.md). The reducers
// below are pure; `terminalsStore.updateLayout` is the one path that commits a
// layout, so `activeByWs` (the focused slot's session) can never drift from it.
// In memory only for now.

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

// ─── Store ────────────────────────────────────────────────────────

const EMPTY_MRU: string[] = [];

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
  /** Forget a deleted session's MRU entry. */
  forget: (workspaceId: string, id: string) => void;
  setResizing: (resizing: boolean) => void;
}

export const useTerminalLayoutStore = create<TerminalLayoutStore>((set, get) => ({
  runByWs: {},
  mruByWs: {},
  resizing: false,

  getRun: (workspaceId) => get().runByWs[workspaceId] ?? EMPTY_RUN_LAYOUT,

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

  forget: (workspaceId, id) =>
    set((s) => {
      const mru = s.mruByWs[workspaceId];
      if (!mru?.includes(id)) return s;
      return { mruByWs: { ...s.mruByWs, [workspaceId]: mru.filter((x) => x !== id) } };
    }),

  setResizing: (resizing) => set((s) => (s.resizing === resizing ? s : { resizing })),
}));

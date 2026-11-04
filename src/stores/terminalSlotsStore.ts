import { create } from "zustand";

// Where each mode wants a terminal on screen
// (docs/superpowers/specs/2026-11-03-run-session-pair-design.md, "Architecture").
// Every `TerminalSlot` placeholder publishes its rect here; the one
// `TerminalHost` positions each pane over its slot, so a pane is never
// re-parented (no remount, no replay, no redraw flash). Mode overlays stay
// mounted while hidden, so a hidden mode's slots keep reporting real rects;
// the host reads only the active mode's.

export type SlotMode = "run" | "talk";

/** A slot's box in viewport pixels (`getBoundingClientRect`). */
export interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SlotEntry {
  mode: SlotMode;
  terminalId: string;
  rect: SlotRect;
}

export function sameRect(a: SlotRect, b: SlotRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * The rect each session gets in `mode`, relative to `origin` (the host's own
 * viewport rect). Other modes' slots are ignored; a session sits in at most
 * one slot per mode, so if two ever claim it the first registered wins.
 */
export function placements(
  slots: Record<string, SlotEntry>,
  mode: SlotMode | null,
  origin: { left: number; top: number },
): Record<string, SlotRect> {
  const out: Record<string, SlotRect> = {};
  if (mode === null) return out;
  for (const slot of Object.values(slots)) {
    if (slot.mode !== mode || slot.terminalId in out) continue;
    out[slot.terminalId] = {
      left: slot.rect.left - origin.left,
      top: slot.rect.top - origin.top,
      width: slot.rect.width,
      height: slot.rect.height,
    };
  }
  return out;
}

interface TerminalSlotsStore {
  /** Keyed by the placeholder's own id. */
  slots: Record<string, SlotEntry>;
  publish: (key: string, entry: SlotEntry) => void;
  withdraw: (key: string) => void;
}

export const useTerminalSlotsStore = create<TerminalSlotsStore>((set) => ({
  slots: {},

  publish: (key, entry) =>
    set((s) => {
      const prev = s.slots[key];
      if (
        prev &&
        prev.mode === entry.mode &&
        prev.terminalId === entry.terminalId &&
        sameRect(prev.rect, entry.rect)
      ) {
        return s;
      }
      return { slots: { ...s.slots, [key]: entry } };
    }),

  withdraw: (key) =>
    set((s) => {
      if (!(key in s.slots)) return s;
      const slots = { ...s.slots };
      delete slots[key];
      return { slots };
    }),
}));

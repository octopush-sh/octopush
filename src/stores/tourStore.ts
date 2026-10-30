import { create } from "zustand";
import type { TourStep } from "../lib/whatsNew";

export type TourMode = "interactive" | "record";

/** The guided tour on screen (`src/lib/tour/runner.ts` drives it,
 *  `TourOverlay` renders it). */
export interface TourState {
  active: boolean;
  mode: TourMode;
  steps: TourStep[];
  /** Index of the step being shown or sought; -1 before the first. */
  index: number;
  /** The spotlit element; null while the runner seeks the next target. */
  target: HTMLElement | null;
}

export const TOUR_IDLE: TourState = { active: false, mode: "interactive", steps: [], index: -1, target: null };

export const useTourStore = create<TourState>(() => ({ ...TOUR_IDLE }));

// `window.__octoTour` — the hook the clip recorder drives (docs/WHATS-NEW.md
// §4–§5). Installed only in dev builds or when the page is loaded with
// `?octo-record=1`; a normal shipped app never exposes it.
import type { TourStep } from "../whatsNew";
import { playTour } from "./runner";

export interface OctoTourApi {
  play(steps: TourStep[], opts?: { mode?: "interactive" | "record"; stepMs?: number }): Promise<number>; // resolves with the number of steps shown
}

declare global {
  interface Window {
    __octoTour?: OctoTourApi;
  }
}

export function shouldInstallTourBridge(dev: boolean, search: string): boolean {
  return dev || new URLSearchParams(search).get("octo-record") === "1";
}

/** Install `window.__octoTour` when allowed. Returns whether it did. */
export function installTourBridge(dev: boolean = import.meta.env.DEV, search: string = window.location.search): boolean {
  if (!shouldInstallTourBridge(dev, search)) return false;
  window.__octoTour = {
    play: (steps, opts = {}) =>
      playTour(steps, { mode: opts.mode ?? "interactive", ...(opts.stepMs !== undefined ? { stepMs: opts.stepMs } : {}) }),
  };
  return true;
}

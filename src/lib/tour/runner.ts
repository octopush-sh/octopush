// Guided-tour runner (docs/WHATS-NEW.md §2–§3). Walks a changeset's `steps`
// over the real UI: open the step's named surface, wait (bounded) for its
// `[data-tour]` target to be visible, spotlight it — or skip the step when the
// target never shows. State lives in `useTourStore`; `TourOverlay` renders it.
//
// Two modes:
//   interactive — the user pages with Next / Back / Close. The tour NEVER acts
//                 on the app: it only opens surfaces and points.
//   record      — for the clip recorder: auto-advances every `stepMs` and
//                 performs each step's `action` halfway through the step.
import { useTourStore, TOUR_IDLE, type TourMode } from "../../stores/tourStore";
import type { TourStep } from "../whatsNew";
import { openSurface } from "./surfaces";

export interface PlayOptions {
  mode?: TourMode;
  /** Record mode: how long each step stays on screen (default 2200ms). */
  stepMs?: number;
  /** How long to wait for a step's target before skipping it (default 2000ms). */
  waitMs?: number;
}

export const DEFAULT_STEP_MS = 2200;
export const DEFAULT_WAIT_MS = 2000;

/** On screen: connected, laid out with a non-zero box, not hidden. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}

function findTarget(id: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(id)}"]`);
  for (const el of all) if (isVisible(el)) return el;
  return null;
}

/** Resolve with the first visible `[data-tour=id]`, watching DOM mutations and
 *  polling each frame (layout changes that mutate nothing), or null after
 *  `timeoutMs`. */
export function waitForTarget(id: string, timeoutMs = DEFAULT_WAIT_MS): Promise<HTMLElement | null> {
  const now = findTarget(id);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    let raf = 0;
    const finish = (el: HTMLElement | null) => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearTimeout(timer);
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
      resolve(el);
    };
    const check = () => {
      const el = findTarget(id);
      if (el) finish(el);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    const frame = () => {
      check();
      if (!done) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // rAF is throttled in background windows; a coarse poll keeps us honest.
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Record mode only: perform a step's action on its target. */
export function performAction(step: TourStep, el: HTMLElement): void {
  switch (step.action ?? "none") {
    case "click":
      el.click();
      break;
    case "hover": {
      const Pointer = (window.PointerEvent ?? MouseEvent) as typeof MouseEvent;
      el.dispatchEvent(new Pointer("pointerover", { bubbles: true }));
      el.dispatchEvent(new Pointer("pointerenter", { bubbles: false }));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      break;
    }
    case "type": {
      const field = el.matches("input, textarea")
        ? (el as HTMLInputElement | HTMLTextAreaElement)
        : el.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
      if (!field) break;
      // Go through the prototype setter so React's controlled inputs see it.
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, step.text ?? "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      break;
    }
    case "none":
      break;
  }
}

// ── session ──────────────────────────────────────────────────────────────

interface Session {
  id: number;
  steps: TourStep[];
  mode: TourMode;
  stepMs: number;
  waitMs: number;
  timers: ReturnType<typeof setTimeout>[];
  resolve: () => void;
}

let current: Session | null = null;
let nextId = 0;

const alive = (s: Session) => current === s;

function clearTimers(s: Session) {
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
}

function end(s: Session) {
  if (!alive(s)) return;
  clearTimers(s);
  current = null;
  useTourStore.setState({ ...TOUR_IDLE });
  s.resolve();
}

/** Seek from step `i` in direction `dir`, skipping steps whose target never
 *  shows. Running off the end finishes the tour; running off the start (Back
 *  with nothing visible before) restores the step that was showing. */
async function seek(s: Session, i: number, dir: 1 | -1): Promise<void> {
  const prev = useTourStore.getState();
  clearTimers(s);
  while (i >= 0 && i < s.steps.length) {
    const step = s.steps[i];
    useTourStore.setState({ index: i, target: null });
    if (step.open) openSurface(step.open);
    const el = await waitForTarget(step.target, s.waitMs);
    if (!alive(s)) return;
    if (el) {
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      useTourStore.setState({ index: i, target: el });
      if (s.mode === "record") scheduleRecord(s, step, el, i);
      return;
    }
    i += dir;
  }
  if (i < 0 && prev.target) {
    useTourStore.setState({ index: prev.index, target: prev.target });
    return;
  }
  end(s);
}

function scheduleRecord(s: Session, step: TourStep, el: HTMLElement, i: number) {
  const half = Math.max(0, Math.round(s.stepMs / 2));
  s.timers.push(
    setTimeout(() => {
      if (!alive(s)) return;
      performAction(step, el);
      s.timers.push(
        setTimeout(() => {
          if (alive(s)) void seek(s, i + 1, 1);
        }, s.stepMs - half),
      );
    }, half),
  );
}

/** Play `steps`; resolves when the tour ends (finished, closed, or replaced by
 *  another `playTour`). An empty list resolves at once. */
export function playTour(steps: TourStep[], opts: PlayOptions = {}): Promise<void> {
  stopTour();
  if (steps.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const s: Session = {
      id: ++nextId,
      steps,
      mode: opts.mode ?? "interactive",
      stepMs: opts.stepMs ?? DEFAULT_STEP_MS,
      waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
      timers: [],
      resolve,
    };
    current = s;
    useTourStore.setState({ active: true, mode: s.mode, steps, index: -1, target: null });
    void seek(s, 0, 1);
  });
}

/** Next step (finishes after the last). */
export function tourNext(): void {
  const s = current;
  if (s) void seek(s, useTourStore.getState().index + 1, 1);
}

/** Previous visible step (stays put when there is none). */
export function tourBack(): void {
  const s = current;
  if (s && useTourStore.getState().index > 0) void seek(s, useTourStore.getState().index - 1, -1);
}

/** Close the tour now. */
export function stopTour(): void {
  if (current) end(current);
}

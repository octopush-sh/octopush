import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HOLD_MS, holdProjectLineFocus, restoreProjectLineFocus, __releaseProjectLineFocus } from "./railFocus";

/** A project line as the rail draws it: replaced, as a move re-renders it. */
function mountLine(projectId: string): HTMLButtonElement {
  document.querySelector(`[data-rail-project-line="${projectId}"]`)?.remove();
  const el = document.createElement("button");
  el.dataset.railProjectLine = projectId;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  __releaseProjectLineFocus();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("holdProjectLineFocus", () => {
  it("brings the focus back to a replaced line within the hold", () => {
    mountLine("dotfiles");
    holdProjectLineFocus("dotfiles");
    vi.advanceTimersByTime(HOLD_MS - 1);
    const moved = mountLine("dotfiles");
    restoreProjectLineFocus();
    expect(moved).toHaveFocus();
  });

  it("lets go after HOLD_MS: a later reload does not take the focus back", () => {
    mountLine("dotfiles");
    holdProjectLineFocus("dotfiles");
    vi.advanceTimersByTime(HOLD_MS);
    // The focus left programmatically (no key, no press), then the projects reloaded.
    (document.activeElement as HTMLElement).blur();
    const reloaded = mountLine("dotfiles");
    restoreProjectLineFocus();
    expect(reloaded).not.toHaveFocus();
  });

  it("a new hold starts its own time", () => {
    mountLine("dotfiles");
    mountLine("scratch");
    holdProjectLineFocus("dotfiles");
    vi.advanceTimersByTime(HOLD_MS - 100);
    holdProjectLineFocus("scratch");
    vi.advanceTimersByTime(500);
    const moved = mountLine("scratch");
    restoreProjectLineFocus();
    expect(moved).toHaveFocus();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HOLD_MS,
  holdMissionRowFocus,
  holdProjectLineFocus,
  restoreProjectLineFocus,
  __releaseProjectLineFocus,
} from "./railFocus";

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

function row(id: string) {
  const el = document.createElement("button");
  el.dataset.railMission = id;
  document.body.appendChild(el);
  return el;
}

describe("holdMissionRowFocus", () => {
  it("gives a mission row the focus back when it was lost, and again when the row is replaced", () => {
    const first = row("w-json");
    holdMissionRowFocus("w-json");
    expect(document.activeElement).toBe(first);
    // "Move to group" renders the row under another parent: a new element.
    first.remove();
    const second = row("w-json");
    restoreProjectLineFocus();
    expect(document.activeElement).toBe(second);
  });

  it("leaves alone a focus a dialog took on purpose (Rename…)", () => {
    row("w-json");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    holdMissionRowFocus("w-json");
    expect(document.activeElement).toBe(input);
  });

  it("is overtaken by the next key, and lets go after HOLD_MS", () => {
    const first = row("w-json");
    holdMissionRowFocus("w-json");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    first.remove();
    const second = row("w-json");
    restoreProjectLineFocus();
    expect(document.activeElement).not.toBe(second);
    holdMissionRowFocus("w-json");
    vi.advanceTimersByTime(HOLD_MS);
    second.remove();
    const third = row("w-json");
    restoreProjectLineFocus();
    expect(document.activeElement).not.toBe(third);
  });
});

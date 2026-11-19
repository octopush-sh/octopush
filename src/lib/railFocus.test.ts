import { describe, it, expect, afterEach } from "vitest";
import { __releaseProjectLineFocus, holdMissionRowFocus, restoreProjectLineFocus } from "./railFocus";

function row(id: string) {
  const el = document.createElement("button");
  el.dataset.railMission = id;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  __releaseProjectLineFocus();
  document.body.innerHTML = "";
});

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

  it("is overtaken by the next key", () => {
    const first = row("w-json");
    holdMissionRowFocus("w-json");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    first.remove();
    const second = row("w-json");
    restoreProjectLineFocus();
    expect(document.activeElement).not.toBe(second);
  });
});

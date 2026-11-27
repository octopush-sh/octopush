import { describe, it, expect } from "vitest";
import { PERMISSION_MODES, isModeChord, isModeNote, nextPermissionMode } from "./permissionModes";

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, repeat: false, key: "π", code: "KeyP", ...over }) as KeyboardEvent;

describe("permission modes", () => {
  it("cycles Plan only, Ask first, Edit freely, then back", () => {
    expect(PERMISSION_MODES.map(nextPermissionMode)).toEqual(["ask", "edit", "plan"]);
  });

  it("the chord is ⌘⌥P by the physical key, never ⇧⇥ or a held key", () => {
    expect(isModeChord(key())).toBe(true);
    expect(isModeChord(key({ code: "", key: "p" }))).toBe(true);
    for (const over of [
      { metaKey: false, ctrlKey: true },
      { ctrlKey: true },
      { altKey: false },
      { metaKey: false },
      { shiftKey: true },
      { repeat: true },
      { code: "KeyO", key: "ø" },
      { metaKey: false, altKey: false, shiftKey: true, code: "Tab", key: "Tab" },
    ]) {
      expect(isModeChord(key(over)), JSON.stringify(over)).toBe(false);
    }
  });

  it("tells the mode note from a stop, by the words the engine writes", () => {
    for (const note of [
      "Plan only from this round on: nothing is written",
      "Ask first from this round on: each change waits for your OK",
      "Edit freely from this round on",
    ]) {
      expect(isModeNote(note), note).toBe(true);
    }
    expect(isModeNote("Generation stopped.")).toBe(false);
  });
});

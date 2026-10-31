import { describe, it, expect } from "vitest";
import { legacyAltArrowSequence } from "./xtermAltArrow";

const key = (k: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}, type = "keydown") => ({
  type,
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("legacyAltArrowSequence", () => {
  it("maps Option+Left/Right to readline word motions on macOS", () => {
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true }), true)).toBe("\x1bb");
    expect(legacyAltArrowSequence(key("ArrowRight", { altKey: true }), true)).toBe("\x1bf");
    // xterm 5 never rewrote Alt+Up/Down on macOS.
    expect(legacyAltArrowSequence(key("ArrowUp", { altKey: true }), true)).toBeNull();
    expect(legacyAltArrowSequence(key("ArrowDown", { altKey: true }), true)).toBeNull();
  });

  it("maps Alt+arrows to Ctrl+arrow sequences elsewhere", () => {
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true }), false)).toBe("\x1b[1;5D");
    expect(legacyAltArrowSequence(key("ArrowRight", { altKey: true }), false)).toBe("\x1b[1;5C");
    expect(legacyAltArrowSequence(key("ArrowUp", { altKey: true }), false)).toBe("\x1b[1;5A");
    expect(legacyAltArrowSequence(key("ArrowDown", { altKey: true }), false)).toBe("\x1b[1;5B");
  });

  it("leaves every other chord to xterm", () => {
    expect(legacyAltArrowSequence(key("ArrowLeft"), true)).toBeNull();
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true, shiftKey: true }), true)).toBeNull();
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true, ctrlKey: true }), true)).toBeNull();
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true, metaKey: true }), true)).toBeNull();
    expect(legacyAltArrowSequence(key("b", { altKey: true }), true)).toBeNull();
    expect(legacyAltArrowSequence(key("ArrowLeft", { altKey: true }, "keyup"), true)).toBeNull();
  });

  it("never fires while an IME is composing", () => {
    expect(legacyAltArrowSequence({ ...key("ArrowLeft", { altKey: true }), isComposing: true }, true)).toBeNull();
    expect(legacyAltArrowSequence({ ...key("ArrowLeft", { altKey: true }), keyCode: 229 }, true)).toBeNull();
  });
});

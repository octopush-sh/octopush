import { describe, it, expect } from "vitest";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { searchKeymap, gotoLine } from "@codemirror/search";
import { foldKeymap, foldCode, unfoldCode } from "@codemirror/language";
import type { KeyBinding } from "@codemirror/view";
import { EDITOR_NAV_KEYS } from "./navKeys";
import { matchShortcut } from "../../hooks/useGlobalShortcuts";

/** A CodeMirror key name as macOS resolves it, modifiers in a fixed order. */
function macChord(key: string): string {
  const parts = key.split(/-(?!$)/);
  const name = parts.pop()!;
  const mods = parts.map((p) =>
    /^(cmd|meta|m|mod)$/i.test(p) ? "Meta"
      : /^(ctrl|control|c)$/i.test(p) ? "Ctrl"
      : /^(shift|s)$/i.test(p) ? "Shift"
      : /^(alt|a)$/i.test(p) ? "Alt"
      : p,
  );
  return [...mods.sort(), name.length === 1 ? name.toLowerCase() : name].join("-");
}

const macKey = (b: KeyBinding) => b.mac ?? b.key;
const chordsOf = (bindings: readonly KeyBinding[]) =>
  bindings.map(macKey).filter((k): k is string => !!k).map(macChord);

const BUILT_IN = [...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap];

describe("editor navigation shortcuts (Appendix C)", () => {
  it("back, forward and next/previous change take no chord CodeMirror already binds", () => {
    const taken = new Set(chordsOf(BUILT_IN));
    const ours = [
      EDITOR_NAV_KEYS.back, EDITOR_NAV_KEYS.forward,
      EDITOR_NAV_KEYS.nextChange, EDITOR_NAV_KEYS.prevChange,
    ].map(macChord);
    expect(new Set(ours).size).toBe(ours.length);
    for (const chord of ours) expect(taken.has(chord), chord).toBe(false);
  });

  it("go to line replaces CodeMirror's own ⌘⌥G binding rather than adding a second", () => {
    const builtIn = searchKeymap.find((b) => b.run === gotoLine);
    expect(builtIn).toBeDefined();
    expect(macChord(EDITOR_NAV_KEYS.gotoLine)).toBe(macChord(macKey(builtIn!)!));
  });

  it("fold and unfold are ⌘⌥[ and ⌘⌥] on macOS", () => {
    const fold = foldKeymap.find((b) => b.run === foldCode)!;
    const unfold = foldKeymap.find((b) => b.run === unfoldCode)!;
    expect(macChord(macKey(fold)!)).toBe("Alt-Meta-[");
    expect(macChord(macKey(unfold)!)).toBe("Alt-Meta-]");
  });

  it("no global shortcut claims any of the editor's navigation chords", () => {
    const presses: KeyboardEventInit[] = [
      { key: "-", code: "Minus", ctrlKey: true },                       // ⌃− back
      { key: "_", code: "Minus", ctrlKey: true, shiftKey: true },       // ⌃⇧− forward
      { key: "F7", code: "F7", altKey: true },                          // ⌥F7
      { key: "F7", code: "F7", altKey: true, shiftKey: true },          // ⇧⌥F7
      { key: "[", code: "BracketLeft", metaKey: true, altKey: true },   // ⌘⌥[ fold
      { key: "]", code: "BracketRight", metaKey: true, altKey: true },  // ⌘⌥] unfold
      { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true },   // ⌃⌥[ fold all
      { key: "]", code: "BracketRight", ctrlKey: true, altKey: true },  // ⌃⌥] unfold all
      { key: "g", code: "KeyG", metaKey: true, altKey: true },          // ⌘⌥G go to line
    ];
    for (const init of presses) {
      expect(matchShortcut(new KeyboardEvent("keydown", init)), JSON.stringify(init)).toBeNull();
    }
  });
});

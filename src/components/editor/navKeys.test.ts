import { describe, it, expect } from "vitest";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { searchKeymap, gotoLine } from "@codemirror/search";
import { foldKeymap, foldCode, unfoldCode } from "@codemirror/language";
import type { KeyBinding } from "@codemirror/view";
import { EDITOR_NAV_KEYS, EDITOR_PANE_KEYS } from "./navKeys";
import { matchShortcut } from "../../hooks/useGlobalShortcuts";

type Platform = "mac" | "other";
const PLATFORMS: Platform[] = ["mac", "other"];

/** A CodeMirror key name as `platform` resolves it, modifiers in a fixed
 *  order. `Mod` is Cmd on macOS and Ctrl everywhere else. */
function chord(key: string, platform: Platform): string {
  const parts = key.split(/-(?!$)/);
  const name = parts.pop()!;
  const mods = parts.map((p) =>
    /^(cmd|meta|m)$/i.test(p) ? "Meta"
      : /^mod$/i.test(p) ? (platform === "mac" ? "Meta" : "Ctrl")
      : /^(ctrl|control|c)$/i.test(p) ? "Ctrl"
      : /^(shift|s)$/i.test(p) ? "Shift"
      : /^(alt|a)$/i.test(p) ? "Alt"
      : p,
  );
  return [...mods.sort(), name.length === 1 ? name.toLowerCase() : name].join("-");
}
const macChord = (key: string) => chord(key, "mac");

/** The key name CodeMirror picks for `b` on `platform` (none if it has none). */
const keyOn = (b: KeyBinding, platform: Platform) =>
  platform === "mac" ? b.mac ?? b.key : b.win ?? b.linux ?? b.key;
const macKey = (b: KeyBinding) => keyOn(b, "mac");
const chordsOf = (bindings: readonly KeyBinding[], platform: Platform) =>
  bindings
    .map((b) => keyOn(b, platform))
    .filter((k): k is string => !!k)
    .map((k) => chord(k, platform));

const BUILT_IN = [...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap];
const NEW_CHORDS = [
  EDITOR_NAV_KEYS.back, EDITOR_NAV_KEYS.forward,
  EDITOR_NAV_KEYS.nextChange, EDITOR_NAV_KEYS.prevChange,
];

describe("editor navigation shortcuts (Appendix C)", () => {
  it.each(PLATFORMS)(
    "on %s, back, forward and next/previous change take no chord CodeMirror or the pane already binds",
    (platform) => {
      // The pane's own bindings win over the built-in keymaps, so a clash with
      // one of them (⌃− against Ctrl+− font size off macOS) silently kills ours.
      const taken = new Set([
        ...chordsOf(BUILT_IN, platform),
        ...chordsOf(Object.values(EDITOR_PANE_KEYS), platform),
      ]);
      const ours = chordsOf(NEW_CHORDS, platform);
      expect(ours).toHaveLength(NEW_CHORDS.length);
      expect(new Set(ours).size).toBe(ours.length);
      for (const c of ours) expect(taken.has(c), `${platform}: ${c}`).toBe(false);
    },
  );

  it("back is ⌃− on macOS and Ctrl+Alt+− elsewhere; forward is Ctrl+Shift+− on both", () => {
    expect(chord(keyOn(EDITOR_NAV_KEYS.back, "mac")!, "mac")).toBe("Ctrl--");
    expect(chord(keyOn(EDITOR_NAV_KEYS.back, "other")!, "other")).toBe("Alt-Ctrl--");
    for (const p of PLATFORMS) {
      expect(chord(keyOn(EDITOR_NAV_KEYS.forward, p)!, p)).toBe("Ctrl-Shift--");
    }
  });

  it("go to line replaces CodeMirror's own ⌘⌥G binding rather than adding a second", () => {
    const builtIn = searchKeymap.find((b) => b.run === gotoLine);
    expect(builtIn).toBeDefined();
    for (const p of PLATFORMS) {
      expect(chord(keyOn(EDITOR_NAV_KEYS.gotoLine, p)!, p)).toBe(chord(keyOn(builtIn!, p)!, p));
    }
  });

  it("fold and unfold are ⌘⌥[ and ⌘⌥] on macOS", () => {
    const fold = foldKeymap.find((b) => b.run === foldCode)!;
    const unfold = foldKeymap.find((b) => b.run === unfoldCode)!;
    expect(macChord(macKey(fold)!)).toBe("Alt-Meta-[");
    expect(macChord(macKey(unfold)!)).toBe("Alt-Meta-]");
  });

  it("no global shortcut claims any of the editor's navigation chords", () => {
    const presses: KeyboardEventInit[] = [
      { key: "-", code: "Minus", ctrlKey: true },                       // ⌃− back (macOS)
      { key: "-", code: "Minus", ctrlKey: true, altKey: true },         // Ctrl+Alt+− back (elsewhere)
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

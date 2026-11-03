/**
 * The editor's own chords, as CodeMirror key names: `key` everywhere, `mac`
 * where macOS differs (CodeMirror picks it there). One table so the shortcut
 * test can check them against every other editor binding and the app's global
 * shortcuts on both platforms (FEATURES.md Appendix C).
 */
export interface EditorChord {
  key: string;
  mac?: string;
}

/** The navigation chords. */
export const EDITOR_NAV_KEYS = {
  /** ⌃− on macOS (Xcode's chord) — back to where the last jump started.
   *  Elsewhere `Mod` is Ctrl, so `Ctrl--` is the font-size chord; Back is
   *  Ctrl+Alt+− there instead (VS Code's Linux chord). */
  back: { key: "Ctrl-Alt--", mac: "Ctrl--" },
  /** ⌃⇧− — forward again (Ctrl+Shift+− elsewhere). */
  forward: { key: "Ctrl-Shift--" },
  /** ⌥F7 / ⇧⌥F7 — next / previous change in the diff gutter. */
  nextChange: { key: "Alt-F7" },
  prevChange: { key: "Shift-Alt-F7" },
  /** ⌘⌥G — go to line; wrapped so the jump joins the back trail. */
  gotoLine: { key: "Mod-Alt-g" },
} as const satisfies Record<string, EditorChord>;

/** The pane's other bindings, listed ahead of CodeMirror's keymaps. */
export const EDITOR_PANE_KEYS = {
  save: { key: "Mod-s" },
  find: { key: "Mod-f" },
  selectAllOccurrences: { key: "Mod-Shift-l" },
  definition: { key: "F12" },
  wrap: { key: "Alt-z" },
  fontUp: { key: "Mod-=" },
  fontDown: { key: "Mod--" },
} as const satisfies Record<string, EditorChord>;

/** The class CodeMirror's go-to-line dialog carries (`getDialog` looks it up). */
export const GOTO_LINE_DIALOG = "cm-goto-line";

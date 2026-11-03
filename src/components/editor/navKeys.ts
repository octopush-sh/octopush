/**
 * The editor's navigation chords, as CodeMirror key names. One table so the
 * shortcut test can check them against every other editor binding and the
 * app's global shortcuts (FEATURES.md Appendix C).
 */
export const EDITOR_NAV_KEYS = {
  /** ⌃− — back to where the last jump started (Xcode's chord). */
  back: "Ctrl--",
  /** ⌃⇧− — forward again. */
  forward: "Ctrl-Shift--",
  /** ⌥F7 / ⇧⌥F7 — next / previous change in the diff gutter. */
  nextChange: "Alt-F7",
  prevChange: "Shift-Alt-F7",
  /** ⌘⌥G — go to line; wrapped so the jump joins the back trail. */
  gotoLine: "Mod-Alt-g",
} as const;

// Option/Alt + arrow → word navigation, as xterm.js 5 did it.
//
// xterm.js 6 dropped a long-standing keyboard hack (xtermjs/xterm.js#5346):
// Alt+Left/Right used to be rewritten to the sequences shells bind to "move
// one word", and now go out as the plain modified-arrow CSI (`ESC [1;3D`),
// which neither bash/readline nor zsh bind by default — Option+Left in the
// Run terminal would stop jumping words. The release notes tell embedders to
// add their own keybinding; this reproduces xterm 5's mapping exactly:
//
//   macOS:  Alt+Left → ESC b    Alt+Right → ESC f       (readline/zsh words)
//   other:  Alt+Left → ESC[1;5D  Alt+Right → ESC[1;5C    (Ctrl+arrow)
//           Alt+Up   → ESC[1;5A  Alt+Down  → ESC[1;5B
//
// Only plain Alt (no Shift/Ctrl/Meta) is rewritten — the only combination
// xterm 5 rewrote — so every other chord keeps xterm 6's own encoding.

const ESC = "\x1b";

type KeyLike = Pick<KeyboardEvent, "type" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/** The bytes xterm.js 5 would have sent for this Alt+arrow keydown, or null
 *  when the event isn't one it rewrote (leave it to xterm). */
export function legacyAltArrowSequence(e: KeyLike, mac: boolean): string | null {
  if (e.type !== "keydown") return null;
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  switch (e.key) {
    case "ArrowLeft":
      return mac ? `${ESC}b` : `${ESC}[1;5D`;
    case "ArrowRight":
      return mac ? `${ESC}f` : `${ESC}[1;5C`;
    case "ArrowUp":
      return mac ? null : `${ESC}[1;5A`;
    case "ArrowDown":
      return mac ? null : `${ESC}[1;5B`;
    default:
      return null;
  }
}

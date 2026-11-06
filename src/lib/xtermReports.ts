// Did the user type this, or did xterm say it on its own?
//
// Everything xterm sends to the PTY comes out of `term.onData` — keys and
// pastes, but also xterm's automatic replies to terminal queries (device
// attributes, cursor position, OSC colour queries, mode reports) and the mouse
// reports it sends while a program tracks the mouse (Claude Code's fullscreen
// renderer does). Those must not count as the user answering a prompt, so
// this recognises a chunk made up only of such sequences.
//
// Known overlap: a cursor-position reply (`ESC[1;2R`) has the same bytes as a
// modified F3 key on some keyboards; it is treated as a reply.

const REPORT = new RegExp(
  [
    // Mouse: SGR (`ESC[<b;x;yM` / `m`), urxvt (`ESC[b;x;yM`), X10 (`ESC[M` + 3 bytes),
    // DEC locator (`ESC[…&w`).
    "\\x1b\\[<\\d+;\\d+;\\d+[Mm]",
    "\\x1b\\[\\d+;\\d+;\\d+M",
    "\\x1b\\[M[\\s\\S]{3}",
    "\\x1b\\[[\\d;]*&w",
    // Device attributes (`ESC[?…c`, `ESC[>…c`), status and cursor position
    // (`ESC[0n`, `ESC[r;cR`, `ESC[?r;cR`), mode reports (`ESC[?…$y`),
    // window reports (`ESC[…t`), keyboard-protocol reply (`ESC[?…u`).
    "\\x1b\\[[?>][\\d;]*c",
    "\\x1b\\[\\d*n",
    "\\x1b\\[\\??\\d+;\\d+(?:;\\d+)?R",
    "\\x1b\\[\\??[\\d;]*\\$y",
    "\\x1b\\[[\\d;]+t",
    "\\x1b\\[\\?\\d*u",
    // Focus in / out.
    "\\x1b\\[[IO]",
    // OSC and DCS replies (colour queries, DECRQSS, XTGETTCAP).
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1bP[^\\x1b]*\\x1b\\\\",
  ].join("|"),
  "y",
);

/** True when `data` from `term.onData` holds anything other than xterm's own
 *  replies and mouse reports — i.e. a key or a paste the user sent. */
export function isTypedInput(data: string): boolean {
  if (data.length === 0) return false;
  let i = 0;
  while (i < data.length) {
    REPORT.lastIndex = i;
    const m = REPORT.exec(data);
    if (!m) return true;
    i += m[0].length;
  }
  return false;
}

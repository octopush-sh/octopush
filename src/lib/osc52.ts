/**
 * OSC 52 — a program in the terminal setting the system clipboard.
 *
 * The sequence is `ESC ] 52 ; Pc ; Pd ST`: `Pc` names the selection(s)
 * (`c` clipboard, `p` primary, `s` select, `0`–`7` cut buffers, may be empty)
 * and `Pd` is the text, base64-encoded — or `?` to ask the terminal to send
 * the clipboard *back* into the program. xterm hands a `registerOscHandler(52)`
 * callback the body after `52;`, i.e. `Pc;Pd`.
 */

/**
 * Longest base64 payload accepted. xterm's own OSC limit is 10 MB; nothing a
 * clipboard holds needs more than this, and it bounds the `atob` allocation
 * a hostile program could trigger.
 */
export const OSC52_MAX_BASE64 = 4 * 1024 * 1024;

/**
 * The text a program asked to put on the clipboard, or `null` for anything
 * that must not reach it:
 * - a `?` query — a *read* request; answering it would leak the clipboard
 *   into the PTY, so it is never honored;
 * - an empty payload — a "clear the clipboard" request we don't honor;
 * - a missing `;` separator, malformed or oversized base64.
 *
 * Decodes base64 to bytes and the bytes as UTF-8 — never `atob` straight to
 * text, which reads each byte as a Latin-1 character and is exactly the bug
 * (xtermjs/xterm.js#6002) that garbles accented and CJK copies elsewhere.
 * Whitespace inside the base64 is tolerated: some senders wrap long payloads.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep === -1) return null;
  const payload = data.slice(sep + 1).replace(/\s+/g, "");
  if (payload === "" || payload === "?") return null;
  if (payload.length > OSC52_MAX_BASE64) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  if (binary.length === 0) return null;
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

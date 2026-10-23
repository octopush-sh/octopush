import type { Terminal } from "@xterm/xterm";

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

/**
 * Minimum spacing between two program-initiated clipboard writes. Within the
 * window the newest payload wins, so a looping program can neither thrash the
 * clipboard nor spam toasts, while a single copy-on-select still lands at once.
 */
export const OSC52_MIN_INTERVAL_MS = 500;

export interface Osc52Options {
  /** Policy: may a program change the clipboard right now? (pane on screen,
   *  window focused, …). Evaluated when the sequence arrives. */
  canCopy: () => boolean;
  /** Performs the write (and whatever feedback goes with it). */
  copy: (text: string) => void;
}

export interface Osc52Clipboard {
  /** Feed PTY output to the terminal. `history` marks replayed scrollback:
   *  an OSC 52 inside it — or inside anything queued behind it — is ignored. */
  write(bytes: Uint8Array, history: boolean): void;
  dispose(): void;
}

/**
 * Honor OSC 52 writes on `term`, with a gate that keeps history off the
 * clipboard.
 *
 * The problem the gate solves: a terminal reattached after an app restart is
 * fed its old scrollback again, and an OSC 52 in there would overwrite the
 * clipboard with whatever the user copied days ago. The caller knows which
 * chunks are history (the backend tags them), and xterm gives us the rest:
 * it parses writes strictly in order and runs a write's callback once that
 * chunk is parsed. So every history chunk is written with a callback and
 * counted until it runs, and an OSC 52 is honored only while that count is
 * zero — which means every history byte, and any history byte queued ahead
 * of a live chunk, is behind the parser. The one sequence this lets through
 * is an OSC 52 that *starts* in the last history chunk and ends in live
 * output: the program was mid-copy at the instant of the attach, which is a
 * live copy.
 *
 * Returning `true` from the handler marks the sequence consumed either way:
 * a `?` query must never fall through to anything that would answer it.
 */
export function attachOsc52Clipboard(term: Terminal, opts: Osc52Options): Osc52Clipboard {
  let historyPending = 0;
  let queued: string | null = null;
  let lastCopyAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (queued === null) return;
    const text = queued;
    queued = null;
    lastCopyAt = Date.now();
    opts.copy(text);
  };

  const handler = term.parser.registerOscHandler(52, (data) => {
    if (historyPending === 0 && opts.canCopy()) {
      const text = decodeOsc52(data);
      if (text !== null) {
        queued = text;
        const wait = OSC52_MIN_INTERVAL_MS - (Date.now() - lastCopyAt);
        if (wait <= 0) flush();
        else if (timer === undefined) timer = setTimeout(flush, wait);
      }
    }
    return true;
  });

  return {
    write(bytes, history) {
      if (!history) {
        term.write(bytes);
        return;
      }
      term.write(bytes, () => {
        historyPending--;
      });
      // Counted after the call: xterm never runs the callback synchronously
      // from here, and a write that throws must not leave the gate stuck.
      historyPending++;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      queued = null;
      handler.dispose();
    },
  };
}

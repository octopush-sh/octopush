import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  attachOsc52Clipboard,
  decodeOsc52,
  OSC52_MAX_BASE64,
  OSC52_MIN_INTERVAL_MS,
} from "./osc52";

/** base64 of the UTF-8 bytes — how a program encodes an OSC 52 payload. */
function b64(text: string): string {
  let bin = "";
  new TextEncoder().encode(text).forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

describe("decodeOsc52", () => {
  it("decodes the payload as UTF-8, not Latin-1", () => {
    // The strings the clipboard bug report was about: accents, a dash, a box bar.
    expect(decodeOsc52(`c;${b64("información — Móvil │")}`)).toBe("información — Móvil │");
    expect(decodeOsc52(`c;${b64("中文 ✓ 🐙")}`)).toBe("中文 ✓ 🐙");
  });

  it("accepts an empty selection parameter and several selections", () => {
    expect(decodeOsc52(`;${b64("x")}`)).toBe("x");
    expect(decodeOsc52(`pc0;${b64("x")}`)).toBe("x");
  });

  it("tolerates whitespace a sender wrapped into the base64", () => {
    const enc = b64("hello world");
    expect(decodeOsc52(`c;${enc.slice(0, 4)}\n ${enc.slice(4)}`)).toBe("hello world");
  });

  it("refuses a query — the clipboard is never read back into the PTY", () => {
    expect(decodeOsc52("c;?")).toBeNull();
    expect(decodeOsc52(";?")).toBeNull();
  });

  it("refuses clears, malformed input and bad base64", () => {
    expect(decodeOsc52("c;")).toBeNull();
    expect(decodeOsc52("")).toBeNull();
    expect(decodeOsc52("c")).toBeNull();
    expect(decodeOsc52("c;%%%")).toBeNull();
    expect(decodeOsc52(`c;${btoa("")}`)).toBeNull();
  });

  it("refuses oversized payloads", () => {
    expect(decodeOsc52(`c;${"A".repeat(OSC52_MAX_BASE64 + 4)}`)).toBeNull();
  });
});

// ─── The gate, against the real xterm ─────────────────────────────
// These run the actual @xterm/xterm 5.5.0 parser, never opened into the DOM
// (the core parses, answers queries and runs write callbacks without a
// renderer), so the ordering the gate relies on — writes parsed in order, a
// write's callback after its chunk, the OSC handler fired while its chunk is
// being parsed — is the real thing, not a mock's idea of it.

const enc = (s: string) => new TextEncoder().encode(s);
/** A complete OSC 52 write sequence, ST-terminated. */
const osc52 = (text: string) => `\x1b]52;c;${b64(text)}\x1b\\`;
/** Let xterm's write loop (a setTimeout 0) run. */
const parsed = () => new Promise<void>((r) => setTimeout(r, 25));

function harness() {
  const term = new Terminal({ allowProposedApi: true });
  const copies: string[] = [];
  let allowed = true;
  const bridge = attachOsc52Clipboard(term, {
    canCopy: () => allowed,
    copy: (t) => copies.push(t),
  });
  return {
    term,
    bridge,
    copies,
    allow(v: boolean) {
      allowed = v;
    },
    cleanup() {
      bridge.dispose();
      term.dispose();
    },
  };
}

describe("attachOsc52Clipboard — against the real xterm", () => {
  it("copies from live output and never from replayed history, even when both are queued at once", async () => {
    const h = harness();
    // What a reattach looks like: history first, live output right behind it,
    // all queued before the parser has touched any of it.
    h.bridge.write(enc(`old prompt ${osc52("stale")}`), true);
    h.bridge.write(enc(`still old ${osc52("staler")}`), true);
    h.bridge.write(enc(`new ${osc52("fresh")}`), false);
    await parsed();
    expect(h.copies).toEqual(["fresh"]);
    h.cleanup();
  });

  it("is not fooled by terminal answers or input while history is parsing", async () => {
    // Replayed scrollback can contain queries the terminal answers through
    // onData (DA1 here); nothing that happens on the way out opens the gate.
    const h = harness();
    const answers: string[] = [];
    h.term.onData((d) => answers.push(d));
    h.bridge.write(enc(`\x1b[c ${osc52("stale")}`), true);
    h.bridge.write(enc(osc52("stale too")), true);
    await parsed();
    expect(answers.length).toBeGreaterThan(0);
    expect(h.copies).toEqual([]);
    h.cleanup();
  });

  it("asks the policy at the moment the sequence arrives", async () => {
    const h = harness();
    h.allow(false);
    h.bridge.write(enc(osc52("hidden")), false);
    await parsed();
    expect(h.copies).toEqual([]);
    h.allow(true);
    h.bridge.write(enc(osc52("shown")), false);
    await parsed();
    expect(h.copies).toEqual(["shown"]);
    h.cleanup();
  });

  it("consumes queries without answering them", async () => {
    const h = harness();
    const answers: string[] = [];
    h.term.onData((d) => answers.push(d));
    h.bridge.write(enc("\x1b]52;c;?\x1b\\"), false);
    await parsed();
    expect(h.copies).toEqual([]);
    expect(answers).toEqual([]);
    h.cleanup();
  });

  it("paces program copies: the first lands at once, the rest coalesce to the newest", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.bridge.write(enc(`${osc52("one")}${osc52("two")}${osc52("three")}`), false);
      await vi.advanceTimersByTimeAsync(1); // xterm parses the chunk
      expect(h.copies).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(OSC52_MIN_INTERVAL_MS - 2);
      expect(h.copies).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(h.copies).toEqual(["one", "three"]);
      h.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening once disposed", async () => {
    const h = harness();
    h.bridge.dispose();
    h.term.write(enc(osc52("after")));
    await parsed();
    expect(h.copies).toEqual([]);
    h.term.dispose();
  });
});

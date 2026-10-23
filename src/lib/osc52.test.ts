import { describe, it, expect } from "vitest";
import { decodeOsc52, OSC52_MAX_BASE64 } from "./osc52";

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

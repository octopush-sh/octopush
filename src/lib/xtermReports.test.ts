import { describe, it, expect } from "vitest";
import { isTypedInput } from "./xtermReports";

describe("isTypedInput", () => {
  it("counts keys and pastes", () => {
    for (const data of ["y", "\r", "\x1b", "\x03", "\x1b[A", "\x1b[1;5D", "\x1bb", "\x1b[200~text\x1b[201~", "hello"]) {
      expect(isTypedInput(data)).toBe(true);
    }
  });

  it("ignores mouse reports", () => {
    for (const data of [
      "\x1b[<64;10;5M",
      "\x1b[<0;3;4m",
      "\x1b[<35;10;5M\x1b[<35;11;5M",
      "\x1b[M`!!",
      "\x1b[32;10;5M",
      "\x1b[4;1;10;5;0&w",
    ]) {
      expect(isTypedInput(data)).toBe(false);
    }
  });

  it("ignores xterm's replies to terminal queries", () => {
    for (const data of [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b[12;40R",
      "\x1b[?12;40;1R",
      "\x1b[?2026;2$y",
      "\x1b[8;24;80t",
      "\x1b[?0u",
      "\x1b[I",
      "\x1b[O",
      "\x1b]11;rgb:1111/1111/1111\x1b\\",
      "\x1b]10;rgb:eeee/eeee/eeee\x07",
      "\x1bP1$r0m\x1b\\",
    ]) {
      expect(isTypedInput(data)).toBe(false);
    }
  });

  it("counts a key that arrives with a report", () => {
    expect(isTypedInput("\x1b[<64;10;5My")).toBe(true);
    expect(isTypedInput("")).toBe(false);
  });
});

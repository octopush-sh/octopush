import { describe, it, expect } from "vitest";
import { nextFocus, type FlatHunk } from "./useDiffKeyboard";

const flat: FlatHunk[] = [
  { fileIdx: 0, hunkIdx: 0 }, { fileIdx: 0, hunkIdx: 1 }, { fileIdx: 1, hunkIdx: 0 },
];

describe("nextFocus", () => {
  it("j advances, clamps at end", () => {
    expect(nextFocus(flat, 0, "j")).toBe(1);
    expect(nextFocus(flat, 2, "j")).toBe(2);
  });
  it("k retreats, clamps at 0", () => {
    expect(nextFocus(flat, 1, "k")).toBe(0);
    expect(nextFocus(flat, 0, "k")).toBe(0);
  });
  it("] jumps to first hunk of next file", () => {
    expect(nextFocus(flat, 0, "]")).toBe(2);
  });
  it("[ jumps to first hunk of prev file", () => {
    expect(nextFocus(flat, 2, "[")).toBe(0);
  });
});

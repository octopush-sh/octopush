import { describe, it, expect, vi } from "vitest";
import type { BlameLine } from "../../lib/ipc";

// JSDOM can't run CodeMirror — mock the gutter factory like the other
// editor-extension tests.
const { gutterMock } = vi.hoisted(() => ({ gutterMock: vi.fn(() => ({ ext: true })) }));
vi.mock("@codemirror/view", () => ({
  gutter: gutterMock,
  GutterMarker: class {},
}));

import { firstOfRuns, blameGutter } from "./blameGutter";

function bl(line: number, shaShort: string): BlameLine {
  return { line, shaShort, authorName: "Ada", timestampMs: 1700000000000, summary: `c-${shaShort}` };
}

describe("firstOfRuns", () => {
  it("keeps only the first line of each contiguous same-commit run", () => {
    const map = firstOfRuns([
      bl(1, "aaaaaaa"),
      bl(2, "aaaaaaa"),
      bl(3, "bbbbbbb"),
      bl(4, "aaaaaaa"),
      bl(5, "aaaaaaa"),
    ]);
    expect([...map.keys()]).toEqual([1, 3, 4]);
    expect(map.get(4)?.shaShort).toBe("aaaaaaa");
  });

  it("a gap in line numbers starts a new run even for the same commit", () => {
    const map = firstOfRuns([bl(1, "aaaaaaa"), bl(5, "aaaaaaa")]);
    expect([...map.keys()]).toEqual([1, 5]);
  });

  it("tolerates unsorted input", () => {
    const map = firstOfRuns([bl(2, "aaaaaaa"), bl(1, "aaaaaaa")]);
    expect([...map.keys()]).toEqual([1]);
  });
});

describe("blameGutter", () => {
  it("builds a CodeMirror gutter extension", () => {
    const ext = blameGutter([bl(1, "aaaaaaa")]);
    expect(gutterMock).toHaveBeenCalledWith(
      expect.objectContaining({ class: "cm-blame-gutter", lineMarker: expect.any(Function) }),
    );
    expect(ext).toEqual({ ext: true });
  });
});

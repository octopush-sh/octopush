// Regression tests for the AI-finding "jump to line" diff anchor (G5).
// The helper is exercised against the REAL DiffLines markup (unified and
// side-by-side) so a render change that breaks line matching fails here,
// not silently in App.navigateToFile.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { DiffLines } from "../components/review/DiffLines";
import type { DiffRow } from "./diffParser";
import { findDiffRowByNewLine, revealDiffTargetWhenReady } from "./diffJump";

const rows: DiffRow[] = [
  { kind: "context", text: "fn main() {", oldLine: 10, newLine: 10 },
  { kind: "del", text: "  old();", oldLine: 11, newLine: null },
  { kind: "add", text: "  fresh();", oldLine: null, newLine: 11 },
  { kind: "add", text: "  more();", oldLine: null, newLine: 12 },
  { kind: "context", text: "}", oldLine: 12, newLine: 13 },
];

function renderMode(mode: "inline" | "sbs"): HTMLElement {
  const { container } = render(
    createElement(DiffLines, { rows, filePath: "src/main.rs", mode }),
  );
  return container as HTMLElement;
}

describe("findDiffRowByNewLine", () => {
  it("unified mode: matches the new-file gutter (2nd span), not the old", () => {
    const el = renderMode("inline");
    const row = findDiffRowByNewLine(el, 11);
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-kind")).toBe("add");
    expect(row!.textContent).toContain("fresh();");
  });

  it("unified mode: context rows resolve by their NEW line number", () => {
    const el = renderMode("inline");
    // new line 13 is the context "}" row (old line 12) — must match by new.
    const row = findDiffRowByNewLine(el, 13);
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-kind")).toBe("context");
    expect(row!.textContent).toContain("}");
  });

  it("side-by-side mode: searches only the new-file (2nd) column", () => {
    const el = renderMode("sbs");
    const row = findDiffRowByNewLine(el, 12);
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-kind")).toBe("add");
    expect(row!.textContent).toContain("more();");
    // Line 11 exists in BOTH columns (old del / new add) — the match must
    // come from the new column (the add row, not the del row).
    const both = findDiffRowByNewLine(el, 11);
    expect(both!.getAttribute("data-kind")).toBe("add");
  });

  it("returns null when the line is not in any visible hunk", () => {
    expect(findDiffRowByNewLine(renderMode("inline"), 999)).toBeNull();
    expect(findDiffRowByNewLine(renderMode("sbs"), 999)).toBeNull();
  });
});

describe("revealDiffTargetWhenReady", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /** Frames run by hand; each one advances the clock 16ms. */
  function frames() {
    let now = 0;
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    return {
      step: (n = 1) => {
        for (let i = 0; i < n; i++) {
          now += 16;
          queue.splice(0).forEach((cb) => cb(now));
        }
      },
    };
  }

  function addSection(file: string) {
    const el = document.createElement("div");
    el.id = `review-file-${encodeURIComponent(file)}`;
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  }

  it("with no wait, tries once a frame later and reports a missing file", async () => {
    const f = frames();
    const found = revealDiffTargetWhenReady("src/a.ts", null, 0);
    f.step();
    expect(await found).toBe(false);
  });

  it("waits for the section to render, then scrolls to it", async () => {
    const f = frames();
    const found = revealDiffTargetWhenReady("src/a.ts", null, 2000);
    f.step(5); // Review's diff has not landed yet
    const el = addSection("src/a.ts");
    f.step();
    expect(await found).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("stops without an answer when the user has moved on, even if the section shows up later", async () => {
    const f = frames();
    const moved = new AbortController();
    const found = revealDiffTargetWhenReady("src/a.ts", null, 2000, { signal: moved.signal });
    f.step(3);
    moved.abort();
    const el = addSection("src/a.ts");
    f.step(2);
    expect(await found).toBeNull();
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it("gives up once the wait has passed", async () => {
    const f = frames();
    const found = revealDiffTargetWhenReady("src/a.ts", null, 100);
    f.step(10);
    expect(await found).toBe(false);
  });
});

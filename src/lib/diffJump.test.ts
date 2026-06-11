// Regression tests for the AI-finding "jump to line" diff anchor (G5).
// The helper is exercised against the REAL DiffLines markup (unified and
// side-by-side) so a render change that breaks line matching fails here,
// not silently in App.navigateToFile.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { DiffLines } from "../components/review/DiffLines";
import type { DiffRow } from "./diffParser";
import { findDiffRowByNewLine } from "./diffJump";

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

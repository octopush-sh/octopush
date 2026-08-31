import { describe, it, expect } from "vitest";
import { resolvePointerTarget, hasNavModifier, type PointerTarget } from "./symbolNav";

/** Ends with an identifier — the shape that makes the blank-margin bug bite. */
const DOC = "  const total = value";
const TOTAL_FROM = DOC.indexOf("total");
const VALUE_FROM = DOC.indexOf("value");

/**
 * A stub with just enough of EditorView to exercise the pointer maths. jsdom
 * has no layout, so a real view's `coordsAtPos` returns nothing useful — and
 * what happens when it DOES return something is precisely the behaviour here.
 *
 * Geometry: one line at y = [0, 20), character `i` sits at x = 10i.
 */
function stubView(overrides: Partial<PointerTarget> = {}): PointerTarget {
  return {
    // CodeMirror answers with the NEAREST text position, clamping to the end of
    // the line for anything past it. That clamp is the whole problem.
    posAtCoords: ({ x }) => Math.max(0, Math.min(DOC.length, Math.round(x / 10))),
    coordsAtPos: (pos) => ({ left: pos * 10, right: pos * 10, top: 0, bottom: 20 }),
    state: {
      sliceDoc: (from, to) => DOC.slice(from, to),
      doc: { length: DOC.length },
    },
    ...overrides,
  };
}

describe("resolvePointerTarget", () => {
  it("resolves the identifier the pointer is over", () => {
    const hit = resolvePointerTarget(stubView(), { x: TOTAL_FROM * 10 + 15, y: 0 });
    expect(hit).toEqual({ name: "total", from: TOTAL_FROM, to: TOTAL_FROM + 5 });
  });

  it("refuses a click in the blank area right of the line", () => {
    // The regression: the clamp above lands on the line end, and the caret-
    // adjacency rule then resolves the line's LAST identifier — so ⌘-clicking
    // empty margin used to navigate to `value` without the reader aiming at it.
    const view = stubView();
    expect(view.posAtCoords({ x: 900, y: 0 })).toBe(DOC.length); // the clamp
    expect(resolvePointerTarget(view, { x: 900, y: 0 })).toBeNull();
  });

  it("refuses a pointer left of the identifier CodeMirror snapped to", () => {
    const snapping = stubView({ posAtCoords: () => VALUE_FROM + 2 });
    expect(resolvePointerTarget(snapping, { x: 10, y: 0 })).toBeNull();
  });

  it("refuses a click in the blank area below the last line", () => {
    // `.cm-content` is at least as tall as its scroller, so posAtCoords answers
    // `doc.length` for any y past the text — the vertical twin of the margin
    // bug above, and it fires whenever the pointer's column happens to overlap.
    const view = stubView();
    const overValue = VALUE_FROM * 10 + 15;
    expect(resolvePointerTarget(view, { x: overValue, y: 10 })?.name).toBe("value");
    expect(resolvePointerTarget(view, { x: overValue, y: 400 })).toBeNull();
  });

  it("allows a click a hair outside the glyph box", () => {
    // Slop, so landing on the very edge of a character still counts.
    const hit = resolvePointerTarget(stubView(), { x: (TOTAL_FROM + 5) * 10 + 2, y: 0 });
    expect(hit?.name).toBe("total");
  });

  it("still resolves a keyword — refusing one is the resolver's job, not the pointer's", () => {
    // Gating the gesture on the keyword pool also killed ⌘-click for ordinary
    // identifiers that happen to be pooled (`type`, `get`, `use`, `record`),
    // and did it silently. The pointer answers what is under it; EditorPane
    // decides what that is worth.
    const constFrom = DOC.indexOf("const");
    expect(resolvePointerTarget(stubView(), { x: constFrom * 10 + 15, y: 0 })?.name).toBe(
      "const",
    );
  });

  it("refuses whitespace and an unresolvable position", () => {
    expect(resolvePointerTarget(stubView(), { x: 5, y: 0 })).toBeNull();
    const blind = stubView({ posAtCoords: () => null });
    expect(resolvePointerTarget(blind, { x: 100, y: 0 })).toBeNull();
  });

  it("trusts the position when there is no layout to check against", () => {
    // jsdom, or a position CodeMirror can't measure: refusing to navigate at
    // all would be worse than trusting posAtCoords.
    const unmeasured = stubView({ coordsAtPos: () => null });
    expect(resolvePointerTarget(unmeasured, { x: 900, y: 900 })?.name).toBe("value");
  });
});

describe("hasNavModifier", () => {
  it("reads the platform's own modifier", () => {
    // jsdom reports a non-Mac platform, so Ctrl is the chord here.
    expect(hasNavModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(hasNavModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(hasNavModifier({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

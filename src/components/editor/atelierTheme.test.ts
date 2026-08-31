import { describe, it, expect } from "vitest";
import {
  editorThemeSpec,
  buildEditorTheme,
  resolveEditorTokens,
  makeEditorThemeSpec,
  type EditorTokens,
} from "./atelierTheme";

/** Deliberately non-palette values so a test failure points at the token that
 *  was dropped rather than at a colour that happens to look plausible. */
const TOKENS: EditorTokens = {
  onyx: "#000000",
  panel: "#111111",
  hairline: "#222222",
  brass: "#abcabc",
  ivory: "#ffffff",
  sage: "#999999",
  mute: "#666666",
  rouge: "#ff0000",
  verdigris: "#00ff00",
  brassGhost: "rgba(0,0,0,0.1)",
  brassFaint: "rgba(0,0,0,0.05)",
  brassGlow: "rgba(0,0,0,0.2)",
  match: "rgba(1,2,3,0.25)",
  matchRing: "rgba(1,2,3,0.5)",
  matchInk: "#fefefe",
  matchCurrent: "#010203",
  matchCurrentInk: "#040506",
  symbol: "rgba(7,8,9,0.1)",
  symbolDef: "rgba(10,11,12,0.1)",
  symbolDefRing: "rgba(10,11,12,0.5)",
  symbolLink: "#0a0b0c",
};

describe("atelierTheme", () => {
  it("defines panel + search selectors so the find UI is themed", () => {
    const keys = Object.keys(editorThemeSpec);
    expect(keys.some((k) => k.includes(".cm-panels"))).toBe(true);
    expect(keys.some((k) => k.includes(".cm-panel.cm-search"))).toBe(true);
    expect(keys.some((k) => k.includes(".cm-searchMatch"))).toBe(true);
  });

  it("buildEditorTheme returns a fresh extension array from live tokens", () => {
    const ext = buildEditorTheme();
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("resolveEditorTokens falls back to the Onyx & Brass palette when no CSS var is set", () => {
    // jsdom has no stylesheet, so getPropertyValue returns "" → fallbacks.
    const t = resolveEditorTokens();
    expect(t.onyx).toBe("#0c0a08");
    expect(t.brass).toBe("#d4a574");
    expect(t.ivory).toBe("#f4ecdb");
  });

  it("makeEditorThemeSpec threads tokens into the editor surface", () => {
    const spec = makeEditorThemeSpec(TOKENS);
    expect(spec["&"].backgroundColor).toBe("#000000");
    expect(spec[".cm-content"].caretColor).toBe("#abcabc");
  });

  it("resolveEditorTokens falls back to the atelier match tokens", () => {
    const t = resolveEditorTokens();
    expect(t.match).toBe("rgba(212, 165, 116, 0.235)");
    expect(t.matchInk).toBe("#f4ecdb");
    expect(t.matchCurrent).toBe("#d4a574");
    expect(t.matchCurrentInk).toBe("#0c0a08");
  });

  describe("search match highlighting", () => {
    const spec = makeEditorThemeSpec(TOKENS);

    it("paints every match with the solved wash and a ring, not a bare 8% tint", () => {
      const match = spec[".cm-searchMatch"];
      expect(match.backgroundColor).toBe(TOKENS.match);
      // The old rule outlined matches in hairline — a near-background line.
      expect(match.outline).toBeUndefined();
    });

    it("bounds each match with a full ring and a small radius", () => {
      // Safe because a match renders as one element — see the comment on the
      // rule. If a cross-token match ever fragments, these two draw seams.
      const match = spec[".cm-searchMatch"];
      expect(match.boxShadow).toBe(`inset 0 0 0 1px ${TOKENS.matchRing}`);
      expect(match.borderRadius).toBe("2px");
    });

    it("gives the current match a solid fill, dropping the ring", () => {
      const current = spec[".cm-searchMatch-selected"];
      expect(current.backgroundColor).toBe(TOKENS.matchCurrent);
      expect(current.boxShadow).toBe("none");
    });

    it("forces the ink on matched text AND its descendants", () => {
      // The descendant half is load-bearing: a syntax span can nest inside the
      // match mark, and `color` inherits, so styling only the match loses.
      expect(spec[".cm-searchMatch, .cm-searchMatch span"].color).toBe(TOKENS.matchInk);
      expect(spec[".cm-searchMatch-selected, .cm-searchMatch-selected span"].color).toBe(
        TOKENS.matchCurrentInk,
      );
    });

    it("orders the current-match rules after the generic ones so they win", () => {
      // Equal specificity — the cascade decides, so insertion order matters.
      const keys = Object.keys(spec);
      const generic = keys.indexOf(".cm-searchMatch, .cm-searchMatch span");
      const current = keys.indexOf(".cm-searchMatch-selected, .cm-searchMatch-selected span");
      expect(generic).toBeGreaterThanOrEqual(0);
      expect(current).toBeGreaterThan(generic);
      expect(keys.indexOf(".cm-searchMatch-selected")).toBeGreaterThan(
        keys.indexOf(".cm-searchMatch"),
      );
    });
  });
});

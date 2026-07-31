import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  rgba,
  luminance,
  contrastRatio,
  composite,
  solveMatchWashAlpha,
  isDarkBackground,
  isHexColor,
  MATCH_WASH_TARGET,
} from "./contrast";

/** Every built-in theme, mirroring src-tauri/src/theme.rs · builtin_themes().
 *  Kept here so the search-match guarantee is asserted against the real
 *  palettes rather than against invented colours. */
const THEMES = [
  { name: "atelier", bg: "#0c0a08", accent: "#d4a574", text: "#f4ecdb", muted: "#6d6354" },
  { name: "vellum", bg: "#f0e7d2", accent: "#8b5a3c", text: "#2a201a", muted: "#9b8b72" },
  { name: "mossbank", bg: "#0a120c", accent: "#c89669", text: "#e8e5da", muted: "#5e6b62" },
  { name: "porcelain-indigo", bg: "#0a0e1c", accent: "#d4a5b8", text: "#e8e8ee", muted: "#5e6378" },
  { name: "ember", bg: "#100806", accent: "#d4805c", text: "#f0e0d0", muted: "#6d5e50" },
  { name: "dark", bg: "#0a0a0b", accent: "#a78bfa", text: "#e4e4e7", muted: "#52525b" },
  { name: "midnight", bg: "#0d1117", accent: "#58a6ff", text: "#c9d1d9", muted: "#484f58" },
  { name: "solarized-dark", bg: "#002b36", accent: "#268bd2", text: "#839496", muted: "#586e75" },
];

describe("hexToRgb", () => {
  it("parses with and without the leading hash", () => {
    expect(hexToRgb("#d4a574")).toEqual([212, 165, 116]);
    expect(hexToRgb("d4a574")).toEqual([212, 165, 116]);
  });

  it("returns null for malformed input rather than NaN channels", () => {
    for (const bad of ["", "#fff", "#12345", "#gggggg", "rgb(1,2,3)"]) {
      expect(hexToRgb(bad)).toBeNull();
    }
  });
});

describe("rgba", () => {
  it("expands a hex triplet to an rgba() string", () => {
    expect(rgba("#d4a574", 0.235)).toBe("rgba(212, 165, 116, 0.235)");
  });

  it("passes malformed input through so a bad token degrades to itself", () => {
    expect(rgba("not-a-color", 0.5)).toBe("not-a-color");
  });
});

describe("luminance / contrastRatio", () => {
  it("anchors on the WCAG extremes", () => {
    expect(luminance([0, 0, 0])).toBeCloseTo(0, 5);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 2);
  });

  it("is symmetric and never below 1", () => {
    const a: [number, number, number] = [212, 165, 116];
    const b: [number, number, number] = [12, 10, 8];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
  });
});

describe("composite", () => {
  it("returns the backdrop at alpha 0 and the source at alpha 1", () => {
    const fg: [number, number, number] = [212, 165, 116];
    const bg: [number, number, number] = [12, 10, 8];
    expect(composite(fg, 0, bg)).toEqual(bg);
    expect(composite(fg, 1, bg)).toEqual(fg);
  });
});

describe("solveMatchWashAlpha", () => {
  it("clears the contrast target on every built-in theme", () => {
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const wash = composite(hexToRgb(t.accent)!, alpha, hexToRgb(t.bg)!);
      expect(
        contrastRatio(wash, hexToRgb(t.bg)!),
        `${t.name} wash must be visible against its own background`,
      ).toBeGreaterThanOrEqual(MATCH_WASH_TARGET);
    }
  });

  it("is the SMALLEST alpha that clears it, so the wash costs the text as little as possible", () => {
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const weaker = composite(hexToRgb(t.accent)!, alpha - 0.005, hexToRgb(t.bg)!);
      expect(
        contrastRatio(weaker, hexToRgb(t.bg)!),
        `${t.name} should not be able to use a weaker wash`,
      ).toBeLessThan(MATCH_WASH_TARGET);
    }
  });

  it("adapts per theme — this is the bug a single hardcoded alpha caused", () => {
    // The old highlight used one fixed value for every palette. Atelier's
    // near-black onyx needs far less accent than vellum's cream to register.
    const atelier = solveMatchWashAlpha("#d4a574", "#0c0a08");
    const vellum = solveMatchWashAlpha("#8b5a3c", "#f0e7d2");
    expect(atelier).toBeCloseTo(0.235, 3);
    expect(vellum).toBeCloseTo(0.31, 3);
    expect(vellum).toBeGreaterThan(atelier);
  });

  it("keeps body text comfortably legible on top of the wash", () => {
    // A wash compresses whatever sits on it. Body text must still clear AA,
    // except on solarized-dark whose own text is only 4.75:1 to begin with.
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const wash = composite(hexToRgb(t.accent)!, alpha, hexToRgb(t.bg)!);
      const onWash = contrastRatio(hexToRgb(t.text)!, wash);
      const onPlain = contrastRatio(hexToRgb(t.text)!, hexToRgb(t.bg)!);
      // Never lose more than 40% of the theme's own baseline.
      expect(onWash / onPlain, `${t.name} text retention`).toBeGreaterThan(0.6);
      if (t.name !== "solarized-dark") {
        expect(onWash, `${t.name} text on wash`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("shows why the ink is forced: dim tokens would fail on the wash", () => {
    // Justifies --octo-match-ink. Comments are deliberately low-contrast, so a
    // match landing in one would end up harder to read than before searching.
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const wash = composite(hexToRgb(t.accent)!, alpha, hexToRgb(t.bg)!);
      expect(
        contrastRatio(hexToRgb(t.muted)!, wash),
        `${t.name} comment colour is expected to fail on the wash`,
      ).toBeLessThan(3);
    }
  });

  it("falls back to the atelier alpha for unparseable colours", () => {
    expect(solveMatchWashAlpha("nope", "#0c0a08")).toBeCloseTo(0.235, 3);
    expect(solveMatchWashAlpha("#d4a574", "nope")).toBeCloseTo(0.235, 3);
  });

  it("caps out when the accent is indistinguishable from the background", () => {
    expect(solveMatchWashAlpha("#0c0a08", "#0c0a08")).toBeCloseTo(0.6, 3);
  });
});

describe("current-match ink", () => {
  it("stays legible on the solid accent fill in every theme", () => {
    // The current match is the theme background inked onto the solid accent.
    for (const t of THEMES) {
      const r = contrastRatio(hexToRgb(t.bg)!, hexToRgb(t.accent)!);
      // solarized-dark's accent is only 4.08:1 against its own background, so
      // it inherits its palette's ceiling; everything else clears AA.
      const floor = t.name === "solarized-dark" ? 4 : 4.5;
      expect(r, `${t.name} current-match ink`).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe("isDarkBackground", () => {
  it("classifies vellum as light and every other built-in as dark", () => {
    for (const t of THEMES) {
      expect(isDarkBackground(t.bg), t.name).toBe(t.name !== "vellum");
    }
  });

  it("calls mid-greys light, where a luminance midpoint would not", () => {
    // Luminance isn't perceptually linear: `luminance < 0.5` only flips around
    // #bcbcbc, so it labels these greys dark and would put a white caret on
    // them. Deciding by which extreme they contrast with better is correct.
    for (const grey of ["#808080", "#999999", "#b0b0b0", "#cccccc"]) {
      expect(isDarkBackground(grey), grey).toBe(false);
    }
    for (const grey of ["#000000", "#333333", "#555555"]) {
      expect(isDarkBackground(grey), grey).toBe(true);
    }
  });

  it("assumes dark when the colour can't be parsed", () => {
    expect(isDarkBackground("")).toBe(true);
  });
});

describe("isHexColor", () => {
  it("accepts only full 6-digit triplets", () => {
    expect(isHexColor("#d4a574")).toBe(true);
    expect(isHexColor("d4a574")).toBe(true);
    // The shapes that would otherwise slip through `rgba`'s pass-through and
    // become an OPAQUE match wash painted over the code.
    for (const bad of ["#fff", "#ffff", "red", "rgb(1,2,3)", "", "#gggggg"]) {
      expect(isHexColor(bad), bad).toBe(false);
    }
  });
});

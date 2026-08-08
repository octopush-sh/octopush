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
  solveTintAlpha,
  DIFF_TINT_TARGET,
} from "./contrast";

/** Every built-in theme, mirroring src-tauri/src/theme.rs · builtin_themes().
 *  Kept here so the search-match guarantee is asserted against the real
 *  palettes rather than against invented colours. */
const THEMES = [
  { name: "atelier", bg: "#0c0a08", accent: "#d4a574", text: "#f4ecdb", muted: "#6d6354" },
  { name: "vellum", bg: "#f2ece0", accent: "#91522c", text: "#2a201a", muted: "#6f5f4a" },
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

  it("expands the 3-digit form, which a hand-written theme.json may well use", () => {
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    // Must agree with the long form it's shorthand for.
    expect(hexToRgb("#abc")).toEqual(hexToRgb("#aabbcc"));
  });

  it("returns null for malformed input rather than NaN channels", () => {
    for (const bad of ["", "#ffff", "#12345", "#gggggg", "rgb(1,2,3)", "white"]) {
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
    const vellum = solveMatchWashAlpha("#91522c", "#f2ece0");
    expect(atelier).toBeCloseTo(0.235, 3);
    expect(vellum).toBeCloseTo(0.295, 3);
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

  it("shows why the ink is forced: dim tokens would fail AA on the wash", () => {
    // Justifies --octo-match-ink. Comments are deliberately low-contrast, so a
    // match landing in one would end up harder to read than before searching.
    //
    // The floor here is AA (4.5), not an absolute number: vellum's corrected
    // text_muted is legible enough (5.23:1) that it survives the wash at
    // 3.48:1 — still a failure, but nowhere near the sub-3 the dark palettes
    // land at. What holds across every theme is that the wash pushes a comment
    // *under* AA, which is the whole argument for repainting the foreground.
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const wash = composite(hexToRgb(t.accent)!, alpha, hexToRgb(t.bg)!);
      expect(
        contrastRatio(hexToRgb(t.muted)!, wash),
        `${t.name} comment colour is expected to fail AA on the wash`,
      ).toBeLessThan(4.5);
    }
  });

  it("costs whatever sits on it a consistent ~34% of its contrast", () => {
    // The figure quoted throughout contrast.ts and themeStore.ts. It falls out
    // of solving for a fixed step rather than a fixed alpha, so it holds
    // regardless of how light or dark the palette is — which is precisely why
    // MATCH_WASH_TARGET can be one number for all themes.
    for (const t of THEMES) {
      const alpha = solveMatchWashAlpha(t.accent, t.bg);
      const wash = composite(hexToRgb(t.accent)!, alpha, hexToRgb(t.bg)!);
      const retention =
        contrastRatio(hexToRgb(t.muted)!, wash) / contrastRatio(hexToRgb(t.muted)!, hexToRgb(t.bg)!);
      expect(retention, `${t.name} wash cost`).toBeGreaterThan(0.63);
      expect(retention, `${t.name} wash cost`).toBeLessThan(0.69);
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

  it("classifies a short-hex white background as light", () => {
    // The theme.json scenario: `"bg": "#fff"` is valid CSS, so the editor really
    // is white and must not get CodeMirror's dark defaults.
    expect(isDarkBackground("#fff")).toBe(false);
    expect(isDarkBackground("#000")).toBe(true);
  });

  it("assumes dark when the colour can't be parsed", () => {
    // Only reachable for a genuinely unusable value (a named colour, say), where
    // there is nothing to measure — dark is the safer guess for a code editor.
    expect(isDarkBackground("")).toBe(true);
    expect(isDarkBackground("white")).toBe(true);
  });
});

describe("isHexColor", () => {
  it("accepts the 3- and 6-digit forms only", () => {
    expect(isHexColor("#d4a574")).toBe(true);
    expect(isHexColor("d4a574")).toBe(true);
    expect(isHexColor("#fff")).toBe(true);
    // The shapes that would otherwise slip through `rgba`'s pass-through and
    // become an OPAQUE match wash painted over the code.
    for (const bad of ["#ffff", "red", "rgb(1,2,3)", "", "#gggggg"]) {
      expect(isHexColor(bad), bad).toBe(false);
    }
  });
});

describe("solveTintAlpha", () => {
  it("returns the smallest alpha clearing the target, and null for junk input", () => {
    const bg = "#0c0a08";
    const alpha = solveTintAlpha("#8fc9a8", bg, DIFF_TINT_TARGET);
    expect(alpha).not.toBeNull();
    const tint = composite(hexToRgb("#8fc9a8")!, alpha!, hexToRgb(bg)!);
    expect(contrastRatio(tint, hexToRgb(bg)!)).toBeGreaterThanOrEqual(DIFF_TINT_TARGET);

    const weaker = composite(hexToRgb("#8fc9a8")!, alpha! - 0.005, hexToRgb(bg)!);
    expect(contrastRatio(weaker, hexToRgb(bg)!)).toBeLessThan(DIFF_TINT_TARGET);

    // Callers derive an rgba() from the result, so an unparseable colour must
    // report failure rather than yield rgba(NaN, …).
    expect(solveTintAlpha("not-a-color", bg, DIFF_TINT_TARGET)).toBeNull();
    expect(solveTintAlpha("#8fc9a8", "chartreuse", DIFF_TINT_TARGET)).toBeNull();
  });

  it("holds one perceptual step for diff rows across every theme", () => {
    // The bug this replaces: diffLineStyle.ts returned a flat 8% verdigris and
    // 8% rouge, tuned against atelier's onyx, for EVERY theme.
    for (const t of THEMES) {
      const alpha = solveTintAlpha(t.accent, t.bg, DIFF_TINT_TARGET);
      const tint = composite(hexToRgb(t.accent)!, alpha!, hexToRgb(t.bg)!);
      expect(
        contrastRatio(tint, hexToRgb(t.bg)!),
        `${t.name} diff tint must register against its own background`,
      ).toBeGreaterThanOrEqual(DIFF_TINT_TARGET);
    }
  });

  it("needs a different alpha on cream than on onyx — the reason it is solved", () => {
    // Atelier's addition tint is unchanged at 8%; vellum's deletion tint lands
    // lower, because a dark red over cream reaches the same step sooner.
    expect(solveTintAlpha("#8fc9a8", "#0c0a08", DIFF_TINT_TARGET)).toBeCloseTo(0.08, 3);
    expect(solveTintAlpha("#b33024", "#f2ece0", DIFF_TINT_TARGET)).toBeCloseTo(0.075, 3);
  });

  it("sits far below the search-match target, since a diff row is a field not a hit", () => {
    expect(DIFF_TINT_TARGET).toBeLessThan(MATCH_WASH_TARGET);
  });
});

describe("vellum, the light theme", () => {
  // The frontend mirror of theme.rs's `vellum_clears_wcag_aa_on_every_surface`.
  // Kept on both sides on purpose: the Rust gate guards the palette source, and
  // this one guards the values the app actually renders with.
  const VELLUM = {
    bg: "#f2ece0",
    panel: "#faf6ec",
    panel2: "#ece4d4",
    borderStrong: "#8a7a5f",
    inks: {
      text: "#2a201a",
      textDim: "#6d5e4b",
      textMuted: "#6f5f4a",
      accent: "#91522c",
      accentDim: "#6d3710",
      success: "#246f47",
      warning: "#7f5300",
      danger: "#b33024",
    },
  };

  const worst = (ink: string) =>
    Math.min(
      ...[VELLUM.bg, VELLUM.panel, VELLUM.panel2].map((s) =>
        contrastRatio(hexToRgb(ink)!, hexToRgb(s)!),
      ),
    );

  it("clears AA for every ink on its worst surface", () => {
    // panel_2 is the hover/popover ground. Checking only `bg` is exactly the
    // trap that produced the original palette, where text_muted read 2.70:1 on
    // the canvas and 2.39:1 on hover.
    for (const [label, ink] of Object.entries(VELLUM.inks)) {
      expect(worst(ink), `vellum ${label} (${ink})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("clears 3:1 for interactive boundaries (WCAG 1.4.11)", () => {
    expect(worst(VELLUM.borderStrong)).toBeGreaterThanOrEqual(3);
    // The focus ring reuses the accent, so it inherits the AA guarantee above.
    expect(worst(VELLUM.inks.accent)).toBeGreaterThanOrEqual(3);
  });

  it("is a light theme by the same test CodeMirror uses", () => {
    expect(isDarkBackground(VELLUM.bg)).toBe(false);
    expect(isDarkBackground(VELLUM.panel2)).toBe(false);
  });

  it("avoids the #000-on-#fff halation extreme", () => {
    const ink = contrastRatio(hexToRgb(VELLUM.inks.text)!, hexToRgb(VELLUM.bg)!);
    expect(ink).toBeGreaterThanOrEqual(10);
    expect(ink).toBeLessThanOrEqual(16);
    expect(contrastRatio(hexToRgb(VELLUM.panel)!, [255, 255, 255])).toBeGreaterThan(1.02);
  });

  it("inverts accent_dim: on cream, emphasis is DARKER than the accent", () => {
    // On onyx, accent_dim is the brighter sibling. Carrying that direction into
    // a light theme is what left the shipped #b07952 at 2.65:1.
    expect(worst(VELLUM.inks.accentDim)).toBeGreaterThan(worst(VELLUM.inks.accent));
    expect(luminance(hexToRgb(VELLUM.inks.accentDim)!)).toBeLessThan(
      luminance(hexToRgb(VELLUM.inks.accent)!),
    );
  });
});

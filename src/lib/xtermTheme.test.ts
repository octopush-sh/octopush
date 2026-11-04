import { describe, it, expect, afterEach, vi } from "vitest";
import { getXtermTheme, terminalCellWidth, XTERM_FONT_FAMILY } from "./xtermTheme";

describe("xtermTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("exports a mono font stack", () => {
    expect(XTERM_FONT_FAMILY).toContain("JetBrains Mono");
  });

  it("falls back to the Onyx & Brass palette when no CSS var is set", () => {
    // jsdom has no stylesheet, so getPropertyValue returns "" → fallbacks.
    const theme = getXtermTheme();
    expect(theme.background).toBe("#0c0a08");
    expect(theme.foreground).toBe("#f4ecdb");
    expect(theme.cursor).toBe("#d4a574");
  });

  it("follows live theme tokens instead of a fixed dark palette", () => {
    // Simulate themeStore.applyThemeToDom having applied "vellum" — a light
    // theme where the fixed dark palette this used to ship would render
    // near-white text on a cream background.
    const root = document.documentElement;
    root.style.setProperty("--color-octo-terminal-bg", "#f0e7d2");
    root.style.setProperty("--color-octo-ivory", "#2a201a");
    root.style.setProperty("--color-octo-sage", "#6b5e4d");
    root.style.setProperty("--color-octo-mute", "#9b8b72");

    const theme = getXtermTheme();
    expect(theme.background).toBe("#f0e7d2");
    expect(theme.foreground).toBe("#2a201a");
    expect(theme.brightWhite).toBe("#2a201a");
    // Foreground must not equal background — the bug this fixes.
    expect(theme.foreground).not.toBe(theme.background);
  });

  it("keeps a column width only once the terminal font has loaded", () => {
    let advance = 7;
    let loaded = false;
    const ctx = { font: "", measureText: () => ({ width: advance * 10 }) };
    const canvas = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    Object.defineProperty(document, "fonts", { configurable: true, value: { check: () => loaded } });
    try {
      // A fallback face is measured, used, but not kept.
      expect(terminalCellWidth(21)).toBe(7);
      advance = 9;
      loaded = true;
      expect(terminalCellWidth(21)).toBe(9);
      // Once loaded, the measurement is kept.
      advance = 11;
      expect(terminalCellWidth(21)).toBe(9);
    } finally {
      canvas.mockRestore();
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("estimates 0.6em without a canvas, and doesn't keep the estimate", () => {
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(terminalCellWidth(20)).toBe(12);
    const ctx = { font: "", measureText: () => ({ width: 130 }) };
    canvas.mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    expect(terminalCellWidth(20)).toBe(13);
    canvas.mockRestore();
  });

  it("tints xterm's own scrollbar from the border tokens", () => {
    const root = document.documentElement;
    root.style.setProperty("--color-octo-border", "#c9ba95");
    root.style.setProperty("--color-octo-border-strong", "#8a7a5c");
    const theme = getXtermTheme();
    expect(theme.scrollbarSliderBackground).toBe("#c9ba95");
    expect(theme.scrollbarSliderHoverBackground).toBe("#8a7a5c");
    expect(theme.scrollbarSliderActiveBackground).toBe("#8a7a5c");
  });
});

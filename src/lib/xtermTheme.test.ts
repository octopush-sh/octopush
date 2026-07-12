import { describe, it, expect, afterEach } from "vitest";
import { getXtermTheme, XTERM_FONT_FAMILY } from "./xtermTheme";

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
});

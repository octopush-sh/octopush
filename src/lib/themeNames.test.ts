import { describe, it, expect } from "vitest";
import { isLegacyTheme, themeLabel } from "./themeNames";

describe("themeLabel", () => {
  it("title-cases every built-in theme id", () => {
    expect(themeLabel("atelier")).toBe("Atelier");
    expect(themeLabel("vellum")).toBe("Vellum");
    expect(themeLabel("mossbank")).toBe("Mossbank");
    expect(themeLabel("ember")).toBe("Ember");
    expect(themeLabel("porcelain-indigo")).toBe("Porcelain & Indigo");
    expect(themeLabel("dark")).toBe("Dark");
    expect(themeLabel("midnight")).toBe("Midnight");
    expect(themeLabel("solarized-dark")).toBe("Solarized Dark");
  });

  it("title-cases a hand-written theme name without dropping it", () => {
    expect(themeLabel("my_night owl")).toBe("My Night Owl");
    expect(themeLabel("Already Cased")).toBe("Already Cased");
  });
});

describe("isLegacyTheme", () => {
  it("marks only the pre-redesign palettes as legacy", () => {
    expect(isLegacyTheme("dark")).toBe(true);
    expect(isLegacyTheme("midnight")).toBe(true);
    expect(isLegacyTheme("solarized-dark")).toBe(true);
    expect(isLegacyTheme("atelier")).toBe(false);
    expect(isLegacyTheme("vellum")).toBe(false);
  });
});

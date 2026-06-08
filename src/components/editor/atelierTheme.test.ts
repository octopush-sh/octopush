import { describe, it, expect } from "vitest";
import { atelierTheme, editorThemeSpec } from "./atelierTheme";

describe("atelierTheme", () => {
  it("is a non-empty extension array", () => {
    expect(Array.isArray(atelierTheme)).toBe(true);
    expect((atelierTheme as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("defines panel + search selectors so the find UI is themed", () => {
    const keys = Object.keys(editorThemeSpec);
    expect(keys.some((k) => k.includes(".cm-panels"))).toBe(true);
    expect(keys.some((k) => k.includes(".cm-panel.cm-search"))).toBe(true);
    expect(keys.some((k) => k.includes(".cm-searchMatch"))).toBe(true);
  });
});

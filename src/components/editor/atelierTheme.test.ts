import { describe, it, expect } from "vitest";
import { atelierTheme } from "./atelierTheme";

describe("atelierTheme", () => {
  it("is a non-empty extension array", () => {
    expect(Array.isArray(atelierTheme)).toBe(true);
    expect((atelierTheme as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("source defines panel + search selectors so the find UI is themed", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    // fileURLToPath on import.meta.url directly — jsdom's URL constructor
    // resolves "new URL('.', import.meta.url)" against its http base, so
    // we must use path.dirname instead of new URL(".", ...) to get the dir.
    const here = path.dirname(url.fileURLToPath(import.meta.url)) + "/";
    const src = fs.readFileSync(here + "atelierTheme.ts", "utf8");
    expect(src).toContain(".cm-panels");
    expect(src).toContain(".cm-search");
  });
});

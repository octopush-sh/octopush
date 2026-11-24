import { describe, it, expect } from "vitest";
import { getViewportForBounds } from "@xyflow/react";
import { FIT_PADDING, flowColorMode } from "./flowTheme";

// The real stylesheets: the one the builder imports, from the installed
// library, and the app's. Vitest blanks CSS imports (`?raw` included), so the
// files are read from the repo root, as ContextHeader.test.tsx does. The app
// ships no @types/node, hence the expect-error.
// @ts-expect-error node:fs is untyped in this project
const fs = await import("node:fs");
const libCss: string = fs.readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8");
const appCss: string = fs.readFileSync("src/styles.css", "utf8");

/** The declarations of the bare `.octo-flow { … }` rule in styles.css. */
function octoFlowVars(): Map<string, string> {
  const block = /^\.octo-flow \{([^}]*)\}/m.exec(appCss)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--xy-[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

describe("builder canvas theme (@xyflow stylesheet)", () => {
  it("sets every variable the library fills with light-dark() from tokens", () => {
    // Each `--x-default: light-dark(…)` is read as `var(--x, var(--x-default))`
    // (the background patterns share one `--xy-background-pattern-color`): the
    // outer name is the one the app sets.
    const themed = [...libCss.matchAll(/(--xy-[\w-]+-default):\s*[^;]*light-dark\(/g)].map((m) => m[1]);
    expect(themed.length).toBeGreaterThan(20);
    const ours = octoFlowVars();
    for (const fallback of themed) {
      const readAs = [...libCss.matchAll(new RegExp(`var\\((--xy-[\\w-]+),\\s*var\\(${fallback}\\)\\)`, "g"))].map((m) => m[1]);
      expect(readAs.length, fallback).toBeGreaterThan(0);
      const set = readAs.filter((name) => ours.has(name));
      expect(set, `${fallback} is read as ${readAs.join(" / ")}, which .octo-flow must set`).not.toEqual([]);
      for (const name of set) {
        const value = ours.get(name)!;
        // Tokens or a keyword, never a colour literal.
        expect(value, name).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|light-dark\(/i);
        expect(value, name).toMatch(/var\(--|^(transparent|none)$/);
      }
    }
  });

  it("still keys light-dark() off color-scheme, which forceColorMode sets", () => {
    expect(libCss).toMatch(/\.react-flow \{[^}]*color-scheme: light dark;/);
    expect(libCss).toMatch(/\.react-flow\.dark \{\s*color-scheme: dark;/);
    expect(libCss).toMatch(/\.react-flow\.light \{\s*color-scheme: light;/);
  });
});

describe("FIT_PADDING", () => {
  it("leaves v12's margin with the real v13 math: 10% of the canvas per side, not 0px", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 500 };
    // v12's `padding: 0.25` gave (1000 - 1000 / 1.25) / 2 = 100px a side → zoom 0.8.
    expect(getViewportForBounds(bounds, 1000, 500, 0.4, 1.75, FIT_PADDING).zoom).toBeCloseTo(0.8);
    // The same number in v13 is 0px: the stages would touch the canvas edges.
    expect(getViewportForBounds(bounds, 1000, 500, 0.4, 1.75, 0.25).zoom).toBeCloseTo(1);
  });
});

describe("flowColorMode", () => {
  it("follows the app theme's ground, dark until a theme is known", () => {
    expect(flowColorMode("#0c0a08")).toBe("dark");
    expect(flowColorMode("#f4efe6")).toBe("light");
    expect(flowColorMode(undefined)).toBe("dark");
    expect(flowColorMode(null)).toBe("dark");
  });
});

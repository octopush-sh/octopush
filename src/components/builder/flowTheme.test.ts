import { describe, it, expect } from "vitest";
import { flowColorMode } from "./flowTheme";

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

describe("flowColorMode", () => {
  it("follows the app theme's ground, dark until a theme is known", () => {
    expect(flowColorMode("#0c0a08")).toBe("dark");
    expect(flowColorMode("#f4efe6")).toBe("light");
    expect(flowColorMode(undefined)).toBe("dark");
    expect(flowColorMode(null)).toBe("dark");
  });
});

import { describe, it, expect } from "vitest";
import { shell } from "./tokens";
import appSrc from "../App.tsx?raw";
import headerSrc from "../components/ContextHeader.tsx?raw";
import bandSrc from "../components/ModeBand.tsx?raw";

// Vitest stubs `.css` imports, so the stylesheet is read from disk.
async function readStylesCss(): Promise<string> {
  // @ts-expect-error node:fs is untyped in this project
  const fs = await import("node:fs");
  return fs.readFileSync("src/styles.css", "utf8");
}

/** The declared value of a custom property in styles.css. */
function cssVar(css: string, name: string): string | undefined {
  return css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
}

/** The class list of the first element in `src` whose classes include `marker`. */
function classesWith(src: string, marker: string): string[] {
  const list = [...src.matchAll(/className="([^"]*)"/g)]
    .map((m) => m[1])
    .find((c) => c.split(/\s+/).includes(marker));
  if (!list) throw new Error(`no className holding "${marker}"`);
  return list.split(/\s+/);
}

describe("shell spacing tokens", () => {
  it("styles.css declares them and tokens.ts mirrors them", async () => {
    const css = await readStylesCss();
    expect(cssVar(css, "--shell-gutter")).toBe(shell.gutter);
    expect(cssVar(css, "--shell-stack")).toBe(shell.stack);
    expect(cssVar(css, "--shell-foot")).toBe(shell.foot);
  });

  it("stay on the 4px scale", () => {
    for (const v of Object.values(shell)) {
      expect(v).toMatch(/^\d+px$/);
      expect(parseInt(v, 10) % 4).toBe(0);
    }
  });

  it("<main> is inset from the rail and the Companion by the gutter", () => {
    const main = appSrc.match(/<main className="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(main).toContain("mx-[var(--shell-gutter)]");
    expect(main.filter((c) => /^-?m[xlr]?-/.test(c))).toEqual(["mx-[var(--shell-gutter)]"]);
  });

  it("the canvas column ends on the foot", () => {
    const column = classesWith(appSrc, "pb-[var(--shell-foot)]");
    expect(column.filter((c) => /^p[by]?-/.test(c))).toEqual(["pb-[var(--shell-foot)]"]);
  });

  it("the ContextHeader and the mode band are spaced by the stack", () => {
    const header = classesWith(headerSrc, "octo-header");
    expect(header.filter((c) => /^-?m[xytb]?-/.test(c))).toEqual(["my-[var(--shell-stack)]"]);
    const band = classesWith(bandSrc, "grid");
    expect(band.filter((c) => /^-?m[xytb]?-/.test(c))).toEqual(["mb-[var(--shell-stack)]"]);
  });
});

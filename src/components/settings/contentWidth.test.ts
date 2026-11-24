import { describe, it, expect } from "vitest";
import { settingsContent } from "../../lib/tokens";
import settingsSrc from "../Settings.tsx?raw";

// Every Settings source file except the tests, as text.
const paneSources = Object.entries(
  import.meta.glob<string>("./*.tsx", { query: "?raw", import: "default", eager: true }),
).filter(([path]) => !path.endsWith(".test.tsx"));

// Vitest stubs `.css` imports, so the stylesheet is read from disk.
async function readStylesCss(): Promise<string> {
  // @ts-expect-error node:fs is untyped in this project
  const fs = await import("node:fs");
  return fs.readFileSync("src/styles.css", "utf8");
}

describe("Settings content column (#1018)", () => {
  it("styles.css declares --settings-content and tokens.ts mirrors it", async () => {
    const css = await readStylesCss();
    expect(css.match(/--settings-content:\s*([^;]+);/)?.[1].trim()).toBe(settingsContent);
  });

  it("stays on the 4px scale", () => {
    expect(settingsContent).toMatch(/^\d+px$/);
    expect(parseInt(settingsContent, 10) % 4).toBe(0);
  });

  it("Settings renders every pane inside the one column", () => {
    const column = settingsSrc.match(/data-testid="settings-content" className="([^"]*)"/)?.[1];
    expect(column?.split(/\s+/)).toEqual(["max-w-[var(--settings-content)]"]);
    // The column holds the pane switch, so no tab can render outside it.
    const body = settingsSrc.slice(settingsSrc.indexOf('data-testid="settings-content"'));
    expect(body.indexOf('tab === "general"')).toBeGreaterThan(0);
    expect(body.indexOf('tab === "about"')).toBeLessThan(body.indexOf("</div>"));
  });

  it("no pane sets a content width of its own", () => {
    expect(paneSources.length).toBeGreaterThan(10);
    for (const [path, src] of paneSources) {
      const widths = src
        .split("\n")
        // A dialog's panel is not pane content: ModalShell sizes it.
        .filter((line) => !line.includes("panelClassName"))
        .flatMap((line) => line.match(/max-w-\[\d+px\]/g) ?? []);
      expect(widths, path).toEqual([]);
    }
  });
});

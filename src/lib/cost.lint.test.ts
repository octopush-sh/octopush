import { describe, it, expect } from "vitest";

/**
 * Every currency figure goes through `formatUsd`, which groups thousands. A
 * hand-rolled `$${x.toFixed(2)}` printed one run as `$12843.27` while the
 * ledger read `$12,843.27`.
 */
// A value's own `.toFixed(2)`; a ternary that picks sub-cent precision
// (`n < 0.01 ? n.toFixed(3) : n.toFixed(2)`) is a deliberate exception.
const FIXED2 = String.raw`\{[\w.!]+(\([\w.]*\))?\.toFixed\(2\)\}`;
const TEMPLATE = new RegExp(String.raw`\$\$` + FIXED2);
const JSX_TEXT = new RegExp(String.raw`\$` + FIXED2);

function rawUsdFigures(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    // Template literal: `$${cost.toFixed(2)}`.
    if (TEMPLATE.test(line)) hits.push(line.trim());
    // JSX text: <span>${cost.toFixed(2)}</span>. Inside a template literal the
    // same characters are a plain interpolation, so skip lines with a backtick.
    else if (!line.includes("`") && JSX_TEXT.test(line)) hits.push(line.trim());
  }
  return hits;
}

describe("currency figures", () => {
  it("the scan catches both spellings and spares plain interpolation", () => {
    expect(rawUsdFigures("body: `spent $${t.costUsd.toFixed(2)}`,")).toHaveLength(1);
    expect(rawUsdFigures("return [`$${Number(v).toFixed(2)} · cost`];")).toHaveLength(1);
    expect(rawUsdFigures('  <span className="x">${s.costUsd.toFixed(2)}</span>')).toHaveLength(1);
    expect(rawUsdFigures("  ${row!.costUsd.toFixed(2)} / ${row!.limitUsd.toFixed(2)}")).toHaveLength(1);
    expect(rawUsdFigures("`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`")).toEqual([]);
    expect(rawUsdFigures("<span>{formatUsd(s.costUsd)}</span>")).toEqual([]);
  });

  it("no source outside cost.ts formats dollars with toFixed(2)", () => {
    const sources = import.meta.glob("../**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (/\.test\.tsx?$/.test(path) || path.endsWith("/cost.ts")) continue;
      for (const hit of rawUsdFigures(src)) offenders.push(`${path}: ${hit}`);
    }
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(offenders, "use formatUsd from src/lib/cost.ts").toEqual([]);
  });
});

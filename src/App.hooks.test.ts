import { describe, expect, it } from "vitest";
// Vite serves the component source as a string; no Node fs under the app tsconfig.
import source from "./App.tsx?raw";

/**
 * Rules-of-hooks guard for `App` (there is no ESLint in this repo).
 *
 * `App` renders a no-project view through an early `return` in the middle of
 * its body. A hook placed after that return runs on some renders and not on
 * others, and React throws "Rendered more hooks than during the previous
 * render" (#310) — the whole tree unmounts to a black window, which is how
 * v0.4.78 shipped. This test pins the invariant at the source level: every
 * hook call in `App` sits above the first body-level early return.
 */
describe("App hooks precede every early return", () => {
  const lines = source.split("\n");
  const appStart = lines.findIndex((l: string) => /^function App\(\)/.test(l));

  it("finds the component and its early-return marker", () => {
    expect(appStart).toBeGreaterThan(-1);
    expect(source).toContain("Hooks end here");
  });

  it("calls no hook after the first body-level early return", () => {
    // The first top-level `if (...) {` block (two-space indent) whose body
    // returns is the earliest render path that skips the rest of the body.
    let earlyReturn = -1;
    for (let i = appStart; i < lines.length; i++) {
      if (/^  if \(.*\) \{$/.test(lines[i])) {
        for (let j = i + 1; j < lines.length && !/^  \}/.test(lines[j]); j++) {
          if (/^    return[ (;<]/.test(lines[j])) {
            earlyReturn = i;
            break;
          }
        }
        if (earlyReturn >= 0) break;
      }
      if (/^  return \(/.test(lines[i])) break; // the component's own JSX return
    }
    expect(earlyReturn).toBeGreaterThan(appStart);

    const offenders: string[] = [];
    for (let i = earlyReturn; i < lines.length; i++) {
      // Only body-level statements (indent 2) — hook names inside nested
      // callbacks/JSX are indented deeper and are not App's own hook calls.
      if (/^  (const|let|var)? ?.*\buse[A-Z]\w*\(/.test(lines[i]) && /^  \S/.test(lines[i])) {
        offenders.push(`${i + 1}: ${lines[i].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
// `?raw` rather than node:fs — it keeps this suite on the same module graph as
// the rest of the frontend (no @types/node), and Vite resolves the paths at
// transform time, so a renamed file fails the build instead of at runtime.
import indexHtml from "../../index.html?raw";
import themeRs from "../../src-tauri/src/theme.rs?raw";
import contrastSrc from "./contrast.test.ts?raw";
import storeSrc from "../stores/themeStore.test.ts?raw";

/**
 * Drift gate for the palettes that are necessarily duplicated outside
 * `src-tauri/src/theme.rs`.
 *
 * Three places restate theme colours because they cannot import the Rust
 * source: the pre-paint script in `index.html` (it runs before any module
 * loads, so tokens don't exist yet), and the two vitest tables that assert
 * against "the real palettes". A silent desync there is quiet and nasty — the
 * pre-paint script would paint last release's ground for a frame, and the test
 * suites would keep passing against colours the app no longer ships.
 *
 * Parsing Rust with a regex is normally a bad idea; here the target is a flat
 * literal list this repo has kept in one shape since the themes were added, and
 * the parse asserts it found what it expected before comparing anything.
 */

/** Extract one theme's fields from `builtin_themes()`. */
function themeFromRust(name: string): Record<string, string> {
  const src = themeRs;
  const start = src.indexOf(`name: "${name}".into(),`);
  expect(start, `${name} must exist in theme.rs`).toBeGreaterThan(-1);
  const end = src.indexOf("},", start);
  const block = src.slice(start, end);
  const fields: Record<string, string> = {};
  for (const m of block.matchAll(/^\s*([a-z_0-9]+): "(#[0-9a-fA-F]{6})"\.into\(\),/gm)) {
    fields[m[1]] = m[2];
  }
  // Every theme carries 14 colour fields; a different count means the parse
  // (or the file's shape) drifted and the comparisons below would be vacuous.
  expect(Object.keys(fields).length, `${name} parsed fields`).toBe(14);
  return fields;
}

describe("palette drift", () => {
  it("index.html's pre-paint constants match theme.rs", () => {
    // A mismatch shows up as a one-frame flash of the wrong ground on launch —
    // invisible in tests, visible to every user, every time.
    const html = indexHtml;

    for (const [constName, themeName] of [
      ["ATELIER", "atelier"],
      ["VELLUM", "vellum"],
    ] as const) {
      const m = html.match(new RegExp(`var ${constName} = \\{([^}]*)\\}`));
      expect(m, `${constName} must be declared in the pre-paint script`).not.toBeNull();

      const declared = Object.fromEntries(
        [...m![1].matchAll(/(\w+):\s*"(#[0-9a-fA-F]{6})"/g)].map((x) => [x[1], x[2]]),
      );
      const rust = themeFromRust(themeName);

      expect(declared.bg, `${constName}.bg`).toBe(rust.bg);
      expect(declared.panel, `${constName}.panel`).toBe(rust.panel);
      expect(declared.text, `${constName}.text`).toBe(rust.text);
      // The script only paints these three; assert it hasn't grown a fourth
      // colour that this gate would then not be checking.
      expect(Object.keys(declared).sort()).toEqual(["bg", "panel", "text"]);
    }
  });

  it("index.html declares the same `dark` flag the palette implies", () => {
    const html = indexHtml;
    expect(html).toMatch(/var ATELIER = \{[^}]*dark: true/);
    expect(html).toMatch(/var VELLUM = \{[^}]*dark: false/);
  });

  it("the vitest palette tables match theme.rs", () => {
    // contrast.test.ts's THEMES and themeStore.test.ts's ATELIER/VELLUM both
    // claim to mirror the Rust source; this is what makes that claim true.

    for (const name of ["atelier", "vellum"]) {
      const rust = themeFromRust(name);

      const row = contrastSrc.match(new RegExp(`\\{ name: "${name}",([^}]*)\\}`));
      expect(row, `${name} row in contrast.test.ts`).not.toBeNull();
      const cells = Object.fromEntries(
        [...row![1].matchAll(/(\w+): "(#[0-9a-fA-F]{6})"/g)].map((x) => [x[1], x[2]]),
      );
      expect(cells.bg, `${name} contrast.test.ts bg`).toBe(rust.bg);
      expect(cells.accent, `${name} contrast.test.ts accent`).toBe(rust.accent);
      expect(cells.text, `${name} contrast.test.ts text`).toBe(rust.text);
      expect(cells.muted, `${name} contrast.test.ts muted`).toBe(rust.text_muted);

      const decl = storeSrc.match(
        new RegExp(`const ${name.toUpperCase()}: ThemeConfig = \\{([^}]*)\\}`),
      );
      expect(decl, `${name} const in themeStore.test.ts`).not.toBeNull();
      const store = Object.fromEntries(
        [...decl![1].matchAll(/(\w+): "(#[0-9a-fA-F]{6})"/g)].map((x) => [x[1], x[2]]),
      );
      // camelCase in TS, snake_case in Rust.
      for (const [ts, rs] of [
        ["bg", "bg"],
        ["panel", "panel"],
        ["panel2", "panel_2"],
        ["border", "border"],
        ["borderStrong", "border_strong"],
        ["accent", "accent"],
        ["accentDim", "accent_dim"],
        ["success", "success"],
        ["warning", "warning"],
        ["danger", "danger"],
        ["text", "text"],
        ["textDim", "text_dim"],
        ["textMuted", "text_muted"],
        ["terminalBg", "terminal_bg"],
      ] as const) {
        expect(store[ts], `${name}.${ts} in themeStore.test.ts`).toBe(rust[rs]);
      }
    }
  });
});

describe("interactive boundaries", () => {
  // Guards the regression this gate was written for: `border_strong` shipped
  // once as a fully-themed, fully-tested token that NO component used, while
  // every real input kept the decorative hairline. Tokens that nothing
  // consumes look like fixes and aren't.
  const sources = import.meta.glob("../components/**/*.tsx", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  /** Opening tags of native form controls, brace-aware so a `>` inside a JSX
   *  expression (`onChange={(e) => …}`) doesn't truncate the tag. */
  function controlTags(src: string): string[] {
    const tags: string[] = [];
    for (const m of src.matchAll(/<(input|textarea|select)\b/g)) {
      let i = m.index! + m[0].length;
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
        i++;
      }
      tags.push(src.slice(m.index!, i + 1));
    }
    return tags;
  }

  it("finds the controls it claims to check", () => {
    // Without this the suite below passes vacuously if the glob or the tag
    // scanner ever stops matching.
    const total = Object.values(sources).reduce((n, s) => n + controlTags(s).length, 0);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(total).toBeGreaterThan(40);
  });

  it("no form control rests on the decorative hairline", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith(".test.tsx")) continue;
      for (const tag of controlTags(src)) {
        if (tag.includes("border-octo-hairline")) {
          offenders.push(`${path}: ${tag.slice(0, 90).replace(/\s+/g, " ")}…`);
        }
      }
    }
    expect(
      offenders,
      "form controls must use border-octo-border-strong (3:1, WCAG 1.4.11), " +
        "not the panel hairline",
    ).toEqual([]);
  });

  it("at least one control actually consumes border_strong", () => {
    const used = Object.values(sources).some((s) =>
      controlTags(s).some((t) => t.includes("border-octo-border-strong")),
    );
    expect(used).toBe(true);
  });
});

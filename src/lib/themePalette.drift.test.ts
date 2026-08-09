import { describe, it, expect } from "vitest";
// `?raw` rather than node:fs — it keeps this suite on the same module graph as
// the rest of the frontend (no @types/node), and Vite resolves the paths at
// transform time, so a renamed file fails the build instead of at runtime.
import indexHtml from "../../index.html?raw";
import themeRs from "../../src-tauri/src/theme.rs?raw";
import contrastSrc from "./contrast.test.ts?raw";
import storeSrc from "../stores/themeStore.test.ts?raw";
import tokensSrc from "./tokens.ts?raw";
import xtermSrc from "./xtermTheme.ts?raw";
import editorThemeSrc from "../components/editor/atelierTheme.ts?raw";

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

describe("static fallbacks track theme.rs", () => {
  // Several places hold a copy of atelier as a literal, because they run before
  // `themeStore` has written anything (first paint) or outside a DOM entirely
  // (unit tests, CodeMirror/xterm theme construction). They drifted once
  // already: `text_muted` was raised in theme.rs to clear AA and every one of
  // these kept shipping the old 3.06:1 value, so the first frame — and the
  // whole non-DOM path — stayed at the failing colour.
  //
  // `src/styles.css` is the one layer NOT checked here: vitest stubs `.css`
  // imports to an empty string, so `?raw` yields nothing and any assertion
  // against it would pass vacuously. It is asserted from the Rust side
  // instead — `styles_css_first_paint_matches_atelier` in theme.rs, which
  // reads it with `include_str!`.
  const atelier = () => themeFromRust("atelier");

  it("the TS token mirror and the non-DOM fallbacks match atelier", () => {
    const a = atelier();
    const grab = (src: string, key: string) => {
      const m = src.match(new RegExp(`\\b${key}:\\s*"(#[0-9a-fA-F]{6})"`));
      return m ? m[1].toLowerCase() : null;
    };
    // lib/tokens.ts — the typed mirror components use for runtime inline styles.
    expect(grab(tokensSrc, "mute"), "tokens.ts mute").toBe(a.text_muted);
    expect(grab(tokensSrc, "sage"), "tokens.ts sage").toBe(a.text_dim);
    expect(grab(tokensSrc, "ivory"), "tokens.ts ivory").toBe(a.text);
    // xterm + CodeMirror: used before `octo:theme` lands and in jsdom tests.
    expect(grab(xtermSrc, "mute"), "xtermTheme fallback mute").toBe(a.text_muted);
    expect(grab(xtermSrc, "sage"), "xtermTheme fallback sage").toBe(a.text_dim);
    expect(grab(editorThemeSrc, "mute"), "atelierTheme fallback mute").toBe(a.text_muted);
    expect(grab(editorThemeSrc, "sage"), "atelierTheme fallback sage").toBe(a.text_dim);
  });

  it("no component hardcodes a palette hex where a token would do", () => {
    // ToolCallCard held the entire atelier palette as literals, so its cards
    // rendered onyx-on-cream under vellum and froze `mute` at the pre-AA value.
    // Inline styles are still fine there — they just have to resolve var().
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(
      import.meta.glob("../components/**/*.tsx", {
        eager: true,
        query: "?raw",
        import: "default",
      }) as Record<string, string>,
    )) {
      if (path.endsWith(".test.tsx")) continue;
      for (const m of src.matchAll(/^const [A-Z_]+ = "(#[0-9a-fA-F]{6})";/gm)) {
        offenders.push(`${path}: ${m[0]}`);
      }
    }
    expect(offenders, "use var(--color-octo-*) in the inline style instead").toEqual([]);
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

  /** `const NAME = "…"` string constants, so a control whose className lives in
   *  a shared variable is still inspected. The first version of this gate only
   *  read class literals inside the tag, which is exactly how nine inputs in
   *  the settings panes kept the hairline while the suite stayed green. */
  function classConstants(src: string): Record<string, string> {
    const consts: Record<string, string> = {};
    for (const m of src.matchAll(/const (\w+) =\s*\n?\s*"([^"]*)"/g)) {
      if (m[2].includes("border-octo-")) consts[m[1]] = m[2];
    }
    // Destructured default parameters (`triggerClassName = DEFAULT_SURFACE,`)
    // alias a constant onto the prop name the tag actually interpolates. Without
    // this, Listbox's own combobox trigger — the default surface behind every
    // dropdown in the app — was scanned but never resolved, so the gate passed
    // while it sat on the hairline.
    for (const m of src.matchAll(/(\w+)\s*=\s*([A-Z][A-Z0-9_]*)\s*[,)]/g)) {
      if (consts[m[2]]) consts[m[1]] = consts[m[2]];
    }
    return consts;
  }

  /** Opening tags of native form controls, with any referenced class constant
   *  inlined. Brace-aware so a `>` inside a JSX expression
   *  (`onChange={(e) => …}`) doesn't truncate the tag.
   *
   *  Deliberately NOT quote-aware. Tracking quotes sounds stricter and is
   *  worse: a JS comment inside an arrow body ("…octopush-mcp's behaviour")
   *  opens a quote that never closes, and the scan then runs to end-of-file
   *  and reports every later hairline in the file as if it were on this
   *  control. Brace-only is correct for every construct in this codebase, and
   *  `tagLooksTruncated` below turns the remaining risk — a literal `>` inside
   *  an attribute string, which would end the tag early — into a loud failure
   *  rather than a silently exempted control. */
  function controlTags(src: string): Array<{ raw: string; expanded: string }> {
    const consts = classConstants(src);
    const tags: Array<{ raw: string; expanded: string }> = [];
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
      const raw = src.slice(m.index!, i + 1);
      let expanded = raw;
      for (const [name, value] of Object.entries(consts)) {
        if (new RegExp(`\\b${name}\\b`).test(raw)) expanded += ` /*${name}*/ ${value}`;
      }
      tags.push({ raw, expanded });
    }
    return tags;
  }

  /** An opening tag longer than any real one in this codebase means the
   *  brace tracker lost sync and the tag swallowed unrelated markup — which
   *  would make every finding after it meaningless. */
  const tagLostSync = (raw: string) => raw.length > 2200 || !raw.trimEnd().endsWith(">");

  /** A control's RESTING boundary. Variant-prefixed classes (`hover:`,
   *  `focus:`) are excluded on purpose: a field that is borderless at rest and
   *  hints with a hairline on hover — the inline-edit pattern in
   *  PipelineBuilder — is a deliberate design, and 1.4.11 has nothing to say
   *  about a hover hint. Inline `style` is checked too, since a border set
   *  there bypasses Tailwind entirely. */
  function restingHairline(tag: string): boolean {
    const stripped = tag.replace(/[\w-]+:border-octo-[\w-]+/g, "");
    const mentionsHairline =
      /\bborder-octo-hairline\b/.test(stripped) ||
      /border:[^,}]*var\(--color-octo-hairline\)/.test(stripped);
    if (!mentionsHairline) return false;

    // A SINGLE-SIDE border is a divider, not a control outline: `border-b` on a
    // role="tablist" separates the tab strip from the editor below it, and
    // 1.4.11 governs the boundary that identifies a component, not every rule
    // an element happens to draw. Only an all-sides `border` counts — which is
    // what an actual control track (SegmentedControl, the Listbox trigger)
    // uses. Without this the gate flags real dividers and becomes noise.
    const allSides = /(?:^|[\s"'`{])border(?![-\w])/.test(stripped);
    return allSides;
  }

  /** Elements that are controls by ARIA role rather than by tag — the custom
   *  combobox trigger and the two switch styles. Walks back from the role
   *  attribute to its own `<`, then forward with the same brace tracker. */
  function roleControlTags(src: string): Array<{ raw: string; expanded: string }> {
    const consts = classConstants(src);
    const out: Array<{ raw: string; expanded: string }> = [];
    for (const m of src.matchAll(/role="(switch|combobox|radiogroup|tablist)"/g)) {
      const open = src.lastIndexOf("<", m.index!);
      if (open === -1) continue;
      let i = open + 1;
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
        i++;
      }
      const raw = src.slice(open, i + 1);
      let expanded = raw;
      for (const [name, value] of Object.entries(consts)) {
        if (new RegExp(`\\b${name}\\b`).test(raw)) expanded += ` /*${name}*/ ${value}`;
      }
      out.push({ raw, expanded });
    }
    return out;
  }

  it("never loses sync while scanning a tag", () => {
    // Guards the failure mode that makes every other assertion here worthless.
    const broken: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      // Both scanners: roleControlTags walks BACKWARD to find its opening `<`,
      // so a `<` inside an earlier attribute would derail it just as silently.
      for (const tag of [...controlTags(src), ...roleControlTags(src)]) {
        if (tagLostSync(tag.raw)) broken.push(`${path}: ${tag.raw.length} chars`);
      }
    }
    expect(broken, "control-tag scanner lost sync").toEqual([]);
  });

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
      for (const { expanded } of controlTags(src)) {
        if (restingHairline(expanded)) {
          offenders.push(`${path}: ${expanded.slice(0, 90).replace(/\s+/g, " ")}…`);
        }
      }
    }
    expect(
      offenders,
      "form controls must use border-octo-border-strong (3:1, WCAG 1.4.11), " +
        "not the panel hairline",
    ).toEqual([]);
  });

  it("finds the role-based controls it claims to check", () => {
    const total = Object.values(sources).reduce((n, s) => n + roleControlTags(s).length, 0);
    expect(total, "expected the switches and the combobox trigger").toBeGreaterThan(3);
  });

  it("no switch, combobox or radiogroup rests on the decorative hairline", () => {
    // The gap the second review left open: a control that is a <button> with
    // role="switch", or one that receives its surface through a prop, is
    // invisible to the native-tag scan above. Both are user-operated, so
    // 1.4.11 applies to them exactly the same.
    //
    // Scope, stated honestly: this covers elements that DECLARE a control role.
    // A bare <button> with a text label and a border does not, and is not
    // scanned — 1.4.11's application to those is genuinely arguable, and
    // guessing would make the gate noisy rather than useful.
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith(".test.tsx")) continue;
      for (const { expanded } of roleControlTags(src)) {
        if (restingHairline(expanded)) {
          offenders.push(`${path}: ${expanded.slice(0, 90).replace(/\s+/g, " ")}…`);
        }
      }
    }
    expect(offenders, "role-based controls must use border-octo-border-strong").toEqual([]);
  });

  it("finds the trigger surfaces it claims to check", () => {
    // Without this, renaming the prop (or switching every call site to a
    // template literal) would leave the scan below asserting nothing at all.
    let seen = 0;
    for (const src of Object.values(sources)) {
      seen += [...src.matchAll(/triggerClassName\s*=/g)].length;
    }
    expect(seen, "expected Listbox's default plus its call-site overrides").toBeGreaterThan(4);
  });

  it("no trigger surface passed as a prop rests on the hairline", () => {
    // `triggerClassName` is how a caller overrides Listbox's own surface, so it
    // bypasses both scanners above.
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith(".test.tsx")) continue;
      for (const m of src.matchAll(/triggerClassName=(?:"([^"]*)"|\{(\w+)\})/g)) {
        const value = m[1] ?? classConstants(src)[m[2]] ?? "";
        if (restingHairline(value)) offenders.push(`${path}: ${value.slice(0, 70)}…`);
      }
    }
    expect(offenders, "trigger surfaces must use border-octo-border-strong").toEqual([]);
  });

  it("at least one control actually consumes border_strong", () => {
    const used = Object.values(sources).some((s) =>
      controlTags(s).some((t) => t.expanded.includes("border-octo-border-strong")),
    );
    expect(used).toBe(true);
  });
});

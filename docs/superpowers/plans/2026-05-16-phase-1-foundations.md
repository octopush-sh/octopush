# Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin Octopus from the current Cursor-purple aesthetic to *Atelier in Onyx & Brass* via design tokens, Spectral font loading, typed TS constants, and an updated Rust default theme — **without touching any component code**.

**Architecture:** Foundation-only. Update CSS variables in `src/styles.css` to the new palette, add Spectral via Google Fonts, introduce typed `tokens.ts` for JS-side access where needed, and update the Rust built-in default theme to match. Legacy CSS variable names (`--color-octo-bg`, `--color-octo-accent`, etc.) stay as aliases pointing at the new colors, so all existing components keep working — they just resolve to the new palette. Structural changes (rail, mode switcher, companion) come in Phase 2.

**Tech stack:** Tailwind v4 (`@theme` block in CSS), CSS custom properties, TypeScript + Vitest, Rust + serde (Tauri-managed theme persistence in `~/.octopus-sh/theme.json`).

---

## Spec reference

Source of truth: [`docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md`](../specs/2026-05-16-octopus-ux-redesign-design.md). Phase 1 ships §2.1 (color tokens), §2.2 (typography), partial §2.3 (motion/easing variables only — actual animations come Phase 7), and the updated Rust default theme.

---

## File structure

**Created**

- `src/lib/tokens.ts` — typed mirror of design tokens (colors, fonts, motion durations and easing). Components that need design values in JS (inline styles from runtime state, third-party lib config) import from here.
- `src/lib/tokens.test.ts` — sanity tests asserting token values match the spec.

**Modified**

- `index.html` — preconnect to Google Fonts; load Spectral italic 400 + 500; swap body classes from `bg-zinc-950 text-zinc-100` to design-token classes.
- `src/styles.css` — replace the `@theme` block with the full Onyx & Brass token set + legacy aliases for backward compatibility + motion variables.
- `src/stores/themeStore.ts` — extend `applyThemeToDom` to set the new semantic token names too (so user-saved themes also update the new tokens).
- `src-tauri/src/theme.rs` — add an `"atelier"` `ThemeConfig` and place it first in `builtin_themes()` so it becomes the default for new installs.
- `src-tauri/src/tests.rs` (if theme tests live here) or the existing `theme.rs` test module — update to assert the new default.

**Not touched in Phase 1**

- No `src/components/*` changes. Components keep their current Tailwind classes; they'll just resolve to the new colors via the legacy aliases.
- No xterm theme override yet (Phase 4 polish).

---

## Color migration table

| Old (will become alias) | Hex (old)  | New canonical token         | Hex (new)  | Notes |
|-------------------------|------------|-----------------------------|------------|-------|
| `--color-octo-bg`       | `#0a0a0b`  | `--color-octo-onyx`         | `#0c0a08`  | Warmer black |
| `--color-octo-panel`    | `#101013`  | `--color-octo-panel`        | `#14110d`  | Same name, new value |
| —                       | —          | `--color-octo-panel-2`      | `#1a160f`  | New token |
| `--color-octo-border`   | `#1f1f25`  | `--color-octo-hairline`     | `#2a2419`  | |
| `--color-octo-accent`   | `#a78bfa`  | `--color-octo-brass`        | `#d4a574`  | The big change |
| `--color-octo-accent-dim` | `#7c6dd8` | `--color-octo-brass-hi`    | `#e8c39a`  | Now warmer/lighter |
| `--color-octo-success`  | `#34d399`  | `--color-octo-verdigris`    | `#8fc9a8`  | Muted |
| `--color-octo-warning`  | `#fbbf24`  | (no direct equivalent — alias points to brass) | `#d4a574` | Brass doubles as warning |
| `--color-octo-danger`   | `#f87171`  | `--color-octo-rouge`        | `#d18b8b`  | Muted |
| —                       | —          | `--color-octo-ivory`        | `#f4ecdb`  | New text-high |
| —                       | —          | `--color-octo-sage`         | `#95897a`  | New body text |
| —                       | —          | `--color-octo-mute`         | `#6d6354`  | New labels/meta |

---

## Tasks

### Task 1: Load Spectral via Google Fonts

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add Google Fonts preconnect + Spectral stylesheet**

Open `index.html` and replace its current `<head>` content with:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>Octopus sh</title>

  <!-- Spectral — display serif for Atelier in Onyx & Brass -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@1,400;1,500&display=swap"
  />
</head>
```

Also replace the body classes (currently `bg-zinc-950 text-zinc-100`) with design-token classes:

```html
<body class="bg-octo-bg text-octo-ivory antialiased">
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

(`bg-octo-bg` is the legacy alias which will point at the new onyx hex after Task 3. `text-octo-ivory` is a new token created in Task 3 — that line will produce a Tailwind warning until Task 3 runs. That's fine; Tasks 1 and 3 land in one commit window or are committed in sequence quickly.)

- [ ] **Step 2: Run the dev server and verify Spectral loads**

```bash
npm run dev
```

Open the running URL in a browser, open DevTools → Network → filter "spectral". You should see `https://fonts.gstatic.com/s/spectral/v15/...woff2` requests with `200 OK`. The body class will not render anything visibly yet (no app surface uses Spectral by default at this point), but the font is now available.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: load Spectral italic for serif display (Phase 1)"
```

---

### Task 2: Create typed design tokens (TDD)

**Files:**
- Create: `src/lib/tokens.ts`
- Create: `src/lib/tokens.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tokens.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { tokens, fonts, ease, dur } from "./tokens";

describe("design tokens — Onyx & Brass", () => {
  it("exports the 11 canonical color tokens with spec hex values", () => {
    expect(tokens.onyx).toBe("#0c0a08");
    expect(tokens.panel).toBe("#14110d");
    expect(tokens.panel2).toBe("#1a160f");
    expect(tokens.hairline).toBe("#2a2419");
    expect(tokens.brass).toBe("#d4a574");
    expect(tokens.brassHi).toBe("#e8c39a");
    expect(tokens.ivory).toBe("#f4ecdb");
    expect(tokens.sage).toBe("#95897a");
    expect(tokens.mute).toBe("#6d6354");
    expect(tokens.verdigris).toBe("#8fc9a8");
    expect(tokens.rouge).toBe("#d18b8b");
  });

  it("exposes brass alpha utilities", () => {
    expect(tokens.brassDim).toBe("rgba(212, 165, 116, 0.4)");
    expect(tokens.brassGhost).toBe("rgba(212, 165, 116, 0.08)");
  });

  it("declares the three type families", () => {
    expect(fonts.serif).toContain("Spectral");
    expect(fonts.sans).toContain("-apple-system");
    expect(fonts.mono).toContain("JetBrains Mono");
  });

  it("exposes the Atelier easing curve", () => {
    expect(ease.octo).toBe("cubic-bezier(0.2, 0.8, 0.3, 1)");
  });

  it("exposes motion durations in milliseconds", () => {
    expect(dur.quick).toBe(220);
    expect(dur.standard).toBe(280);
    expect(dur.slow).toBe(320);
    expect(dur.reveal).toBe(600);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/lib/tokens.test.ts
```

Expected: the test file errors with `Failed to load url ./tokens` / `Cannot find module './tokens'`. That's the correct failure — the implementation doesn't exist yet.

- [ ] **Step 3: Create the tokens module**

Create `src/lib/tokens.ts`:

```typescript
// Typed mirror of the CSS theme tokens defined in src/styles.css.
//
// Prefer Tailwind utility classes (bg-octo-onyx, text-octo-brass, etc.) for
// component styling — they generate the same CSS variables. Reach for this
// module only when you need a value in JS (inline styles from runtime state,
// configuring a third-party lib like xterm or recharts).
//
// Source of truth: docs/design-system.md

export const tokens = {
  // Surfaces
  onyx: "#0c0a08",
  panel: "#14110d",
  panel2: "#1a160f",
  hairline: "#2a2419",

  // Brass — the single accent
  brass: "#d4a574",
  brassHi: "#e8c39a",
  brassDim: "rgba(212, 165, 116, 0.4)",
  brassGhost: "rgba(212, 165, 116, 0.08)",

  // Text
  ivory: "#f4ecdb",
  sage: "#95897a",
  mute: "#6d6354",

  // Status
  verdigris: "#8fc9a8",
  rouge: "#d18b8b",
} as const;

export const fonts = {
  serif: '"Spectral", "Iowan Old Style", "Times New Roman", serif',
  sans: '-apple-system, "Helvetica Neue", sans-serif',
  mono: '"JetBrains Mono", "SF Mono", monospace',
} as const;

export const ease = {
  octo: "cubic-bezier(0.2, 0.8, 0.3, 1)",
} as const;

export const dur = {
  quick: 220,
  standard: 280,
  slow: 320,
  reveal: 600,
} as const;

export type Token = keyof typeof tokens;
export type Font = keyof typeof fonts;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/lib/tokens.test.ts
```

Expected: 5/5 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tokens.ts src/lib/tokens.test.ts
git commit -m "feat: typed design tokens for Atelier in Onyx & Brass"
```

---

### Task 3: Rewrite CSS `@theme` block with Onyx & Brass

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Replace the `@theme` block**

Open `src/styles.css`. Replace the existing `@theme { … }` block (currently lines 4–15) with:

```css
@theme {
  /* ── Fonts ───────────────────────────────────────────────────── */
  --font-serif: "Spectral", "Iowan Old Style", "Times New Roman", serif;
  --font-sans: -apple-system, "Helvetica Neue", sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace;

  /* ── Color tokens — canonical Onyx & Brass ───────────────────── */
  --color-octo-onyx:      #0c0a08;
  --color-octo-panel:     #14110d;
  --color-octo-panel-2:   #1a160f;
  --color-octo-hairline:  #2a2419;

  --color-octo-brass:     #d4a574;
  --color-octo-brass-hi:  #e8c39a;

  --color-octo-ivory:     #f4ecdb;
  --color-octo-sage:      #95897a;
  --color-octo-mute:      #6d6354;

  --color-octo-verdigris: #8fc9a8;
  --color-octo-rouge:     #d18b8b;

  /* ── Legacy aliases — used by components until Phase 7 retires them.
     Same hex as their canonical counterpart so nothing visibly breaks. ── */
  --color-octo-bg:         #0c0a08;
  --color-octo-border:     #2a2419;
  --color-octo-accent:     #d4a574;
  --color-octo-accent-dim: #e8c39a;
  --color-octo-success:    #8fc9a8;
  --color-octo-warning:    #d4a574;
  --color-octo-danger:     #d18b8b;
}

/* ── Brass alpha utilities — not Tailwind-class-generated, used directly ── */
:root {
  --brass-dim:   rgba(212, 165, 116, 0.4);
  --brass-ghost: rgba(212, 165, 116, 0.08);

  /* Motion */
  --ease-octo:    cubic-bezier(0.2, 0.8, 0.3, 1);
  --dur-quick:    220ms;
  --dur-standard: 280ms;
  --dur-slow:     320ms;
  --dur-reveal:   600ms;
}
```

Leave the rest of `styles.css` (xterm overrides, pulse keyframes, etc.) untouched.

- [ ] **Step 2: Run typecheck to ensure Tailwind config still resolves**

```bash
npm run typecheck
```

Expected: no errors. (Typecheck doesn't validate Tailwind CSS, but it catches any TS code that referenced removed tokens — none should exist for Phase 1.)

- [ ] **Step 3: Run the dev server and visually verify the new palette**

```bash
npm run dev
```

Open the app in a browser. Even without any other change, you should see:

- The app background shifted from cool near-black `#0a0a0b` to warmer onyx `#0c0a08`.
- Any element using `bg-octo-panel` is now `#14110d` instead of `#101013` (subtle but warmer).
- **The accent color across the entire app went from purple `#a78bfa` to brass `#d4a574`** — workspace creator buttons, the "New Workspace" CTA, focus rings, etc.
- Success indicators are now muted verdigris instead of bright emerald.

If the dev server isn't picking up CSS changes, kill it and restart with `npm run dev`.

- [ ] **Step 4: Run frontend tests to confirm no regression**

```bash
npm test
```

Expected: all existing tests pass (the only test added so far is `tokens.test.ts` from Task 2; nothing else should be affected).

- [ ] **Step 5: Commit**

```bash
git add src/styles.css
git commit -m "feat: Onyx & Brass theme tokens (Phase 1 foundations)"
```

---

### Task 4: Add the Atelier theme as the Rust built-in default

**Files:**
- Modify: `src-tauri/src/theme.rs`

- [ ] **Step 1: Write the failing tests**

Open `src-tauri/src/theme.rs`. Find the `#[cfg(test)] mod tests` block (currently lines 105–126). Replace its two test functions with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_themes_includes_atelier_as_default() {
        let themes = builtin_themes();
        assert!(themes.len() >= 4, "should have at least 4 built-in themes");
        assert_eq!(
            themes[0].name, "atelier",
            "atelier must be first so it's the default for new installs"
        );
        assert_eq!(themes[0].bg, "#0c0a08", "atelier bg must be onyx");
        assert_eq!(themes[0].accent, "#d4a574", "atelier accent must be brass");
        assert_eq!(themes[0].text, "#f4ecdb", "atelier text must be ivory");
        assert_eq!(themes[0].success, "#8fc9a8", "atelier success must be verdigris");
        assert_eq!(themes[0].danger, "#d18b8b", "atelier danger must be rouge");
    }

    #[test]
    fn legacy_themes_remain_available() {
        let themes = builtin_themes();
        let names: Vec<&str> = themes.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"dark"), "legacy dark theme must still exist");
        assert!(names.contains(&"midnight"), "midnight must still exist");
        assert!(names.contains(&"solarized-dark"), "solarized-dark must still exist");
    }

    #[test]
    fn theme_serde_roundtrip() {
        let theme = &builtin_themes()[0];
        let json = serde_json::to_string(theme).unwrap();
        let back: ThemeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "atelier");
        assert_eq!(back.accent, "#d4a574");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd src-tauri && cargo test theme:: --no-fail-fast
```

Expected: `builtin_themes_includes_atelier_as_default` and `theme_serde_roundtrip` fail (no "atelier" theme yet). `legacy_themes_remain_available` may still pass since the legacy ones are unchanged.

- [ ] **Step 3: Add the Atelier theme**

Still in `src-tauri/src/theme.rs`, replace the `builtin_themes()` function body. Add the new theme at the **front** of the vec, keep the existing three after:

```rust
pub fn builtin_themes() -> Vec<ThemeConfig> {
    vec![
        ThemeConfig {
            name: "atelier".into(),
            bg: "#0c0a08".into(),
            panel: "#14110d".into(),
            border: "#2a2419".into(),
            accent: "#d4a574".into(),
            accent_dim: "#e8c39a".into(),
            success: "#8fc9a8".into(),
            warning: "#d4a574".into(),
            danger: "#d18b8b".into(),
            text: "#f4ecdb".into(),
            text_dim: "#95897a".into(),
            text_muted: "#6d6354".into(),
            terminal_bg: "#0c0a08".into(),
        },
        ThemeConfig {
            name: "dark".into(),
            bg: "#0a0a0b".into(),
            panel: "#101013".into(),
            border: "#1f1f25".into(),
            accent: "#a78bfa".into(),
            accent_dim: "#7c6dd8".into(),
            success: "#34d399".into(),
            warning: "#fbbf24".into(),
            danger: "#f87171".into(),
            text: "#e4e4e7".into(),
            text_dim: "#a1a1aa".into(),
            text_muted: "#52525b".into(),
            terminal_bg: "#0a0a0b".into(),
        },
        ThemeConfig {
            name: "midnight".into(),
            bg: "#0d1117".into(),
            panel: "#161b22".into(),
            border: "#21262d".into(),
            accent: "#58a6ff".into(),
            accent_dim: "#388bfd".into(),
            success: "#3fb950".into(),
            warning: "#d29922".into(),
            danger: "#f85149".into(),
            text: "#c9d1d9".into(),
            text_dim: "#8b949e".into(),
            text_muted: "#484f58".into(),
            terminal_bg: "#0d1117".into(),
        },
        ThemeConfig {
            name: "solarized-dark".into(),
            bg: "#002b36".into(),
            panel: "#073642".into(),
            border: "#586e75".into(),
            accent: "#268bd2".into(),
            accent_dim: "#2176b8".into(),
            success: "#859900".into(),
            warning: "#b58900".into(),
            danger: "#dc322f".into(),
            text: "#839496".into(),
            text_dim: "#657b83".into(),
            text_muted: "#586e75".into(),
            terminal_bg: "#002b36".into(),
        },
    ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test theme:: --no-fail-fast
```

Expected: all 3 theme tests pass.

- [ ] **Step 5: Run the full Rust test suite**

```bash
cd src-tauri && cargo test
```

Expected: all tests pass. (No other test should depend on the order or count of built-in themes.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/theme.rs
git commit -m "feat: add Atelier built-in theme as Rust default"
```

---

### Task 5: Apply new semantic tokens in `themeStore`

**Files:**
- Modify: `src/stores/themeStore.ts`

This lets user-customized themes (loaded via `themeStore.apply`) drive the new semantic tokens too, not just the legacy ones. Without this, a user who customizes the accent color would update `--color-octo-accent` but not `--color-octo-brass`, so new components in later phases wouldn't reflect the customization.

- [ ] **Step 1: Update `applyThemeToDom`**

Replace the `applyThemeToDom` function in `src/stores/themeStore.ts` with:

```typescript
function applyThemeToDom(t: ThemeConfig) {
  const root = document.documentElement;

  // Legacy token names — still used by current components.
  root.style.setProperty("--color-octo-bg", t.bg);
  root.style.setProperty("--color-octo-panel", t.panel);
  root.style.setProperty("--color-octo-border", t.border);
  root.style.setProperty("--color-octo-accent", t.accent);
  root.style.setProperty("--color-octo-accent-dim", t.accentDim);
  root.style.setProperty("--color-octo-success", t.success);
  root.style.setProperty("--color-octo-warning", t.warning);
  root.style.setProperty("--color-octo-danger", t.danger);

  // New canonical semantic tokens — used by components from Phase 2 onward.
  // Map ThemeConfig fields to the new names.
  root.style.setProperty("--color-octo-onyx", t.bg);
  root.style.setProperty("--color-octo-hairline", t.border);
  root.style.setProperty("--color-octo-brass", t.accent);
  root.style.setProperty("--color-octo-brass-hi", t.accentDim);
  root.style.setProperty("--color-octo-ivory", t.text);
  root.style.setProperty("--color-octo-sage", t.textDim);
  root.style.setProperty("--color-octo-mute", t.textMuted);
  root.style.setProperty("--color-octo-verdigris", t.success);
  root.style.setProperty("--color-octo-rouge", t.danger);

  // panel-2 has no equivalent in ThemeConfig yet. Leave the static
  // styles.css value alone — user themes won't customize it in Phase 1.

  // Body bg for first paint before React mounts.
  document.body.style.backgroundColor = t.bg;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run frontend tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/stores/themeStore.ts
git commit -m "feat: apply new semantic tokens to DOM (Phase 1)"
```

---

### Task 6: End-to-end visual verification & user-theme migration check

**Files:** none (verification only — but if the migration check reveals an issue, a follow-up patch may be needed)

- [ ] **Step 1: Boot the full Tauri app**

```bash
npm run tauri:dev
```

Wait for the app to launch. The first launch after this change might use a user-saved theme.json from a previous session.

- [ ] **Step 2: Check whether you have a saved theme.json**

In a separate terminal:

```bash
ls -la ~/.octopus-sh/theme.json 2>/dev/null && cat ~/.octopus-sh/theme.json
```

If the file exists, it was saved by `themeStore` before this change and contains the **old "dark" theme values**. The app will load those (purple accent, cooler black). To verify Atelier becomes the default for fresh users:

```bash
mv ~/.octopus-sh/theme.json ~/.octopus-sh/theme.json.backup
```

Then restart `npm run tauri:dev`. The app should now load with brass accent, warm onyx background, ivory text.

- [ ] **Step 3: Walk through the existing screens and confirm visual changes**

Expected post-Task-3+5 (no structural changes — just colors and font availability):

| Surface | Expected change |
|---------|-----------------|
| Welcome | Background warmer; "New Project" button and accent borders are now brass. |
| Project sidebar | Active workspace pill is brass (was purple). |
| WorkspaceBar | Active tab underline is brass. Subtab active background is the new panel tone. |
| ChatView | "Send" button (the arrow-up icon button) is brass-tinted. Tool cards still readable. |
| Terminal | xterm renders against new onyx bg. Selection / cursor colors unchanged in Phase 1 (Phase 4 problem). |

If anything looks broken (white-on-white, invisible borders), capture a screenshot and note the surface — but **do not fix it in Phase 1**. Track it as a Phase 2/4 polish task. Phase 1 is foundations only.

- [ ] **Step 4: Restore your prior theme file if you backed it up**

```bash
mv ~/.octopus-sh/theme.json.backup ~/.octopus-sh/theme.json 2>/dev/null || true
```

(If you don't want to restore the old theme — for example, you want to dogfood Atelier going forward — leave it deleted. The app will use the new built-in default.)

- [ ] **Step 5: Final commit (if any tweaks were needed)**

If Steps 1–3 didn't surface any required code changes, no commit needed.

If a surface looks broken AND it's a one-line fix in `styles.css` (e.g., a missing token mapping), apply the fix and commit:

```bash
git add src/styles.css
git commit -m "fix: <specific surface> color mapping (Phase 1 polish)"
```

Otherwise log the issue (note the surface name + description) for the Phase 2 plan.

- [ ] **Step 6: Mark Phase 1 done**

Final sanity check:

```bash
git log --oneline -8
npm run typecheck && cd src-tauri && cargo test && cd ..
```

Expected:
- Recent commits should be 4–5 Phase 1 commits.
- Typecheck and Rust tests pass.

Phase 1 ships. The app now wears Onyx & Brass; the structural overhaul (rail, modes, companion) is Phase 2.

---

## Self-review notes (recorded after writing this plan)

**Spec coverage:**
- §2.1 (color tokens) → Tasks 2, 3, 4, 5 ✓
- §2.2 (typography) → Task 1 (font load) + Task 3 (font tokens in `@theme`) ✓
- §2.3 (spacing/radii/borders) → spacing+radii live as Tailwind defaults; no token additions needed in Phase 1. Brass rule is a Phase 7 concern. ✓
- Motion variables (ease-octo, durations) → declared in Task 3's `:root` block for future phases ✓
- Rust default theme update (Phase 1 explicit deliverable in spec §7) → Task 4 ✓
- `themeStore` update → Task 5 ✓
- `tokens.ts` (referenced by CLAUDE.md and design-system.md) → Task 2 ✓

**Type/name consistency check:**
- `tokens.brass` (TS) / `--color-octo-brass` (CSS) / `accent: "#d4a574"` (Rust ThemeConfig field) — three names for the same value across three layers. Documented in the migration table and consistent in every task.
- `tokens.brassHi` vs `--color-octo-brass-hi` vs `accent_dim` (Rust uses snake_case). Mapping is explicit in Task 5.
- `panel2` (TS) vs `--color-octo-panel-2` (CSS) — kept consistent. Rust ThemeConfig has no `panel2` field; not customizable in Phase 1 per Task 5 comment.

**Risks acknowledged:**
- Spectral CDN dependency: if Google Fonts is unreachable, Spectral falls back to `Iowan Old Style` then `Times New Roman` then `serif`. Acceptable for Phase 1; self-hosting deferred per spec.
- Users with custom `theme.json` keep their old purple. Phase 1 doesn't migrate them — by design, since the spec defers migration until later phases when components structurally depend on brass. Task 6 walks the user through verifying Atelier loads for a fresh install.
- No `eslint-no-hex-literals` rule enforced yet. CLAUDE.md captures the rule informally; a real lint pass is a future enhancement (not Phase 1 scope).

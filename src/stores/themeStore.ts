import { create } from "zustand";
import { ipc } from "../lib/ipc";
import {
  DIFF_TINT_TARGET,
  isDarkBackground,
  isHexColor,
  rgba,
  solveMatchWashAlpha,
  solveTintAlpha,
} from "../lib/contrast";
import type { ThemeConfig } from "../lib/types";

/** localStorage key holding a mirror of the applied theme.
 *
 *  The real store is `~/.octopush/theme.json`, but reading it costs an async
 *  IPC round trip that resolves long after first paint — so a vellum user used
 *  to watch the window flash onyx on every launch. The pre-paint script in
 *  index.html reads THIS mirror synchronously and paints the correct ground
 *  before React mounts. Keep the key in sync with that script. */
const MIRROR_KEY = "octo:theme";

/** Media query backing "follow the OS" mode. */
const darkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** Guards against stacking a second OS listener if `load()` ever runs twice
 *  (a remount, a retry after a failed IPC call). The listener is cheap but
 *  duplicates would repaint — and dispatch `octo:theme` — once per copy. */
let systemListenerBound = false;

interface ThemeState {
  theme: ThemeConfig | null;
  themes: ThemeConfig[];
  loading: boolean;
  /** True while no explicit choice is stored, so the app is tracking the OS
   *  appearance. Any `apply()` persists a choice and turns this off for good. */
  followingSystem: boolean;

  load: () => Promise<void>;
  apply: (theme: ThemeConfig) => Promise<void>;
}

/** The built-in theme to seed with when the user has no stored preference.
 *  Falls back to the first built-in (atelier) if a name ever goes missing. */
function seedTheme(themes: ThemeConfig[], prefersDark: boolean): ThemeConfig | null {
  if (themes.length === 0) return null;
  const wanted = prefersDark ? "atelier" : "vellum";
  return themes.find((t) => t.name === wanted) ?? themes[0];
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: null,
  themes: [],
  loading: false,
  followingSystem: false,

  load: async () => {
    set({ loading: true });
    try {
      const [stored, themes] = await Promise.all([
        ipc.getTheme(),
        ipc.listThemes(),
      ]);

      // An `apply()` may have landed while the IPC above was in flight — a
      // click during startup, or a second `load()`. Everything below derives
      // from `stored`, a snapshot taken before that choice existed, so acting
      // on it now would repaint over the user's pick (and, on the seed path,
      // switch OS-following back on, leaving the listener free to keep
      // overwriting it until restart). The themes list is still worth
      // keeping — it only populates the picker.
      //
      // Checked BEFORE the `stored` branch, not after: a returning user is
      // precisely the case where `stored` is non-null, so guarding only the
      // seed path would leave the more common half of the race open.
      if (get().theme && !get().followingSystem) {
        set({ themes, loading: false });
        return;
      }

      if (stored) {
        set({ theme: stored, themes, loading: false, followingSystem: false });
        applyThemeToDom(stored);
        return;
      }

      // No explicit choice: honour the OS and keep honouring it. We do NOT
      // persist this — writing theme.json here would freeze the app to
      // whatever the desktop happened to be on first launch, which is the
      // opposite of respecting the preference.
      const seeded = seedTheme(themes, darkQuery?.matches ?? true);
      set({ theme: seeded, themes, loading: false, followingSystem: true });
      if (seeded) applyThemeToDom(seeded, { following: true });

      if (darkQuery && !systemListenerBound) {
        systemListenerBound = true;
        darkQuery.addEventListener("change", (e) => {
          // Re-checked on every fire rather than captured: the user may have
          // picked a theme since, which ends the tracking for good.
          if (!get().followingSystem) return;
          const next = seedTheme(get().themes, e.matches);
          if (!next) return;
          set({ theme: next });
          applyThemeToDom(next, { following: true });
        });
      }
    } catch {
      set({ loading: false });
    }
  },

  apply: async (theme) => {
    set({ theme, followingSystem: false });
    applyThemeToDom(theme);
    await ipc.setTheme(theme);
  },
}));

/** @param following - true when `t` was seeded from the OS rather than chosen.
 *  A seeded theme must NOT leave a colour mirror behind: the pre-paint script
 *  trusts the mirror over `matchMedia`, so a stale one would paint last
 *  night's appearance after the desktop changed while the app was closed —
 *  reintroducing the very flash the mirror exists to remove, for exactly the
 *  never-chose population that this path serves. */
function applyThemeToDom(t: ThemeConfig, { following = false } = {}) {
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
  root.style.setProperty("--color-octo-panel-2", t.panel2);
  root.style.setProperty("--color-octo-hairline", t.border);
  root.style.setProperty("--color-octo-brass", t.accent);
  root.style.setProperty("--color-octo-brass-hi", t.accentDim);
  root.style.setProperty("--color-octo-ivory", t.text);
  root.style.setProperty("--color-octo-sage", t.textDim);
  root.style.setProperty("--color-octo-mute", t.textMuted);
  root.style.setProperty("--color-octo-verdigris", t.success);
  root.style.setProperty("--color-octo-rouge", t.danger);

  // Interactive boundary — inputs, control edges, the focus ring. Separate
  // from the decorative hairline above because WCAG 1.4.11 applies to
  // controls, not to the lines that merely divide panels (see theme.rs).
  root.style.setProperty("--color-octo-border-strong", t.borderStrong);

  // Native form controls, scrollbars and the caret follow `color-scheme`.
  // It used to be a hardcoded `<meta content="dark">` in index.html, which
  // left vellum with dark scrollbars and a dark-styled caret on cream.
  const dark = isDarkBackground(t.bg);
  root.style.setProperty("color-scheme", dark ? "dark" : "light");

  // xterm.js can't read CSS variables directly, so terminal surfaces
  // (TerminalPane, TerminalView) resolve this token themselves off :root
  // via lib/xtermTheme.ts's getXtermTheme() — see that file for why.
  root.style.setProperty("--color-octo-terminal-bg", t.terminalBg);

  // Accent-derived alpha tokens. These were hardcoded to the brass
  // colorway in styles.css; deriving them from the active accent makes
  // hover/active surfaces follow the theme instead of staying brass
  // regardless. Critical for the light theme — a faint brass tint over
  // a cream bg would look brown-stained instead of subtly highlighted.
  root.style.setProperty("--brass-faint", rgba(t.accent, 0.04));
  root.style.setProperty("--brass-ghost", rgba(t.accent, 0.08));
  root.style.setProperty("--brass-glow", rgba(t.accent, 0.12));
  root.style.setProperty("--brass-dim", rgba(t.accent, 0.4));
  root.style.setProperty("--brass-quiet", rgba(t.accent, 0.22));
  root.style.setProperty("--brass-rule-dim", rgba(t.accent, 0.18));

  // `--brass-line` is the one accent alpha that is not a fixed step: it inks
  // solid connectors and The Octo's back-arm row, and 55% of a light accent
  // over cream leaves the silhouette too thin to read. Light themes take it
  // to 75%. Same class of bug as a hairline logo vanishing on white.
  root.style.setProperty("--brass-line", rgba(t.accent, dark ? 0.55 : 0.75));

  // Status-colour alphas. Previously frozen at the atelier verdigris/rouge —
  // so under vellum a "deleted line" row was tinted with the DARK theme's
  // rouge, at an alpha tuned against near-black.
  root.style.setProperty("--verdigris-ghost", rgba(t.success, 0.08));
  root.style.setProperty("--verdigris-strong", rgba(t.success, 0.3));
  root.style.setProperty("--rouge-ghost", rgba(t.danger, 0.08));
  root.style.setProperty("--rouge-strong", rgba(t.danger, 0.28));
  root.style.setProperty("--rouge-active-bg", rgba(t.danger, 0.1));
  root.style.setProperty("--rouge-disabled-bg", rgba(t.danger, 0.05));
  root.style.setProperty("--rouge-border", rgba(t.danger, 0.3));
  root.style.setProperty("--warning-ghost", rgba(t.warning, 0.08));
  root.style.setProperty("--warning-border", rgba(t.warning, 0.3));

  // Sticky rail backdrops composite over the canvas, so the scrim has to be
  // the theme's own background, not a fixed near-black.
  root.style.setProperty("--onyx-40", rgba(t.bg, 0.4));

  // Diff row tints. A flat 0.08 was correct only for atelier: the same alpha
  // is a different perceptual step on cream, so the alpha is solved per theme
  // to hold one constant step (see DIFF_TINT_TARGET). Consumed by
  // lib/diffLineStyle.ts, which used to return the literal rgba() values.
  //
  // Solved against `bg`: DiffViewer's rows sit on an unpainted card that
  // inherits the canvas ground, not on `panel`. Solving equalises the two
  // tints as a side effect — a flat 0.08 gave the addition and deletion rows
  // measurably different weights even on atelier, because verdigris and rouge
  // do not share a luminance.
  setSolvedTint(root, "--diff-add-bg", t.success, t.bg, "rgba(143, 201, 168, 0.08)");
  setSolvedTint(root, "--diff-del-bg", t.danger, t.bg, "rgba(209, 139, 139, 0.08)");

  // Find-in-file match tokens. Unlike the alpha steps above these are not a
  // fixed ladder: the wash alpha is solved against this theme's own background
  // so a match is equally present on onyx and on cream (see
  // solveMatchWashAlpha). The match also owns its foreground — a wash costs
  // whatever sits on it ~34% of its contrast, which body text absorbs but dim
  // comments don't. Consumed by components/editor/atelierTheme.ts.
  //
  // These four are the only tokens derived here that end up OPAQUE, so unlike
  // the alpha ladders above they can't lean on `rgba`'s pass-through: a
  // hand-edited ~/.octopush/theme.json with a short hex (`#fff`) would make
  // `--octo-match` a solid slab painted over the code. Fall back to the atelier
  // answer for the whole group instead, so the highlight stays coherent.
  if (isHexColor(t.accent) && isHexColor(t.bg) && isHexColor(t.text)) {
    const washAlpha = solveMatchWashAlpha(t.accent, t.bg);
    root.style.setProperty("--octo-match", rgba(t.accent, washAlpha));
    root.style.setProperty("--octo-match-ring", rgba(t.accent, Math.min(1, washAlpha * 2)));
    root.style.setProperty("--octo-match-ink", t.text);
    root.style.setProperty("--octo-match-current", t.accent);
    root.style.setProperty("--octo-match-current-ink", t.bg);

    // Symbol occurrences ride on the same guard: they mix `text` and `accent`
    // with `rgba`, so a short hex would slip through as an opaque slab exactly
    // the way the match tokens would. The wash is a fixed low alpha rather than
    // a solved one — it must stay BELOW the find-match wash on every theme (it
    // paints unbidden, and it never repaints the foreground it sits under), so
    // pinning it low is the requirement, not a compromise.
    root.style.setProperty("--octo-symbol", rgba(t.text, 0.1));
    root.style.setProperty("--octo-symbol-def", rgba(t.accent, 0.1));
    root.style.setProperty("--octo-symbol-def-ring", rgba(t.accent, 0.5));
    root.style.setProperty("--octo-symbol-link", t.accent);
  } else {
    for (const token of [
      "--octo-match",
      "--octo-match-ring",
      "--octo-match-ink",
      "--octo-match-current",
      "--octo-match-current-ink",
      "--octo-symbol",
      "--octo-symbol-def",
      "--octo-symbol-def-ring",
      "--octo-symbol-link",
    ]) {
      root.style.removeProperty(token);
    }
  }

  // Body bg for first paint before React mounts.
  document.body.style.backgroundColor = t.bg;

  // Mirror for the pre-paint script (see MIRROR_KEY). Best-effort: a failure
  // here costs a one-frame flash on the NEXT launch, never this session, so it
  // must not break theme application.
  try {
    if (following) {
      // Clear rather than skip: an earlier explicit choice may have left a
      // mirror behind, and it would now outrank the OS on next launch.
      window.localStorage.removeItem(MIRROR_KEY);
    } else {
      window.localStorage.setItem(
        MIRROR_KEY,
        JSON.stringify({ bg: t.bg, panel: t.panel, text: t.text, dark }),
      );
    }
  } catch {
    /* private mode / quota — the app still themes correctly this session */
  }

  // Notify non-CSS surfaces that can't read `var(--…)` directly — the
  // CodeMirror editor and xterm.js terminals, whose theme APIs need
  // concrete colors. EditorPane and TerminalPane/TerminalView listen for
  // this and rebuild their theme from the live tokens (see
  // components/editor/atelierTheme.ts · buildEditorTheme and
  // lib/xtermTheme.ts · getXtermTheme).
  window.dispatchEvent(new CustomEvent("octo:theme"));
}

/** Write one solved diff tint, falling back to the atelier literal when either
 *  colour is unparseable — the same defensive posture as the match group. */
function setSolvedTint(
  root: HTMLElement,
  token: string,
  color: string,
  surface: string,
  fallback: string,
) {
  const alpha = solveTintAlpha(color, surface, DIFF_TINT_TARGET);
  root.style.setProperty(token, alpha === null ? fallback : rgba(color, alpha));
}

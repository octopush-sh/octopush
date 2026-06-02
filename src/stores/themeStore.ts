import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ThemeConfig } from "../lib/types";

interface ThemeState {
  theme: ThemeConfig | null;
  themes: ThemeConfig[];
  loading: boolean;

  load: () => Promise<void>;
  apply: (theme: ThemeConfig) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: null,
  themes: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const [theme, themes] = await Promise.all([
        ipc.getTheme(),
        ipc.listThemes(),
      ]);
      set({ theme, themes, loading: false });
      applyThemeToDom(theme);
    } catch {
      set({ loading: false });
    }
  },

  apply: async (theme) => {
    set({ theme });
    applyThemeToDom(theme);
    await ipc.setTheme(theme);
  },
}));

/** Parse `#rrggbb` (with or without leading #) into an [r,g,b] tuple.
 *  Returns null for malformed input so callers can fall back to a static
 *  value rather than emit `rgba(NaN, NaN, NaN, …)`. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

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
  root.style.setProperty("--color-octo-panel-2", t.panel2);
  root.style.setProperty("--color-octo-hairline", t.border);
  root.style.setProperty("--color-octo-brass", t.accent);
  root.style.setProperty("--color-octo-brass-hi", t.accentDim);
  root.style.setProperty("--color-octo-ivory", t.text);
  root.style.setProperty("--color-octo-sage", t.textDim);
  root.style.setProperty("--color-octo-mute", t.textMuted);
  root.style.setProperty("--color-octo-verdigris", t.success);
  root.style.setProperty("--color-octo-rouge", t.danger);

  // Accent-derived alpha tokens. These were hardcoded to the brass
  // colorway in styles.css; deriving them from the active accent makes
  // hover/active surfaces follow the theme instead of staying brass
  // regardless. Critical for the light theme — a faint brass tint over
  // a cream bg would look brown-stained instead of subtly highlighted.
  root.style.setProperty("--brass-faint", rgba(t.accent, 0.04));
  root.style.setProperty("--brass-ghost", rgba(t.accent, 0.08));
  root.style.setProperty("--brass-glow", rgba(t.accent, 0.12));
  root.style.setProperty("--brass-dim", rgba(t.accent, 0.4));

  // Danger-derived alpha tokens (rouge family) — same reason as above.
  root.style.setProperty("--rouge-active-bg", rgba(t.danger, 0.1));
  root.style.setProperty("--rouge-border", rgba(t.danger, 0.3));

  // Body bg for first paint before React mounts.
  document.body.style.backgroundColor = t.bg;
}

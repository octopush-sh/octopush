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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ThemeConfig } from "../lib/types";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: { getTheme: vi.fn(), setTheme: vi.fn(), listThemes: vi.fn() },
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));

/** The two themes themeStore seeds from, mirroring src-tauri/src/theme.rs. */
const ATELIER: ThemeConfig = {
  name: "atelier",
  bg: "#0c0a08",
  panel: "#14110d",
  panel2: "#1a160f",
  border: "#2a2419",
  borderStrong: "#786747",
  accent: "#d4a574",
  accentDim: "#e8c39a",
  success: "#8fc9a8",
  warning: "#dfae4a",
  danger: "#d18b8b",
  text: "#f4ecdb",
  textDim: "#95897a",
  textMuted: "#8c7f6c",
  terminalBg: "#0c0a08",
};

const VELLUM: ThemeConfig = {
  name: "vellum",
  bg: "#f2ece0",
  panel: "#faf6ec",
  panel2: "#ece4d4",
  border: "#c9ba95",
  borderStrong: "#8a7a5f",
  accent: "#91522c",
  accentDim: "#6d3710",
  success: "#246f47",
  warning: "#7f5300",
  danger: "#b33024",
  text: "#2a201a",
  textDim: "#6d5e4b",
  textMuted: "#6f5f4a",
  terminalBg: "#f2ece0",
};

const read = (token: string) =>
  document.documentElement.style.getPropertyValue(token).trim();

/** matchMedia is absent in jsdom. Install a controllable stub BEFORE importing
 *  the store, which captures the query at module scope. */
let mediaListeners: Array<(e: { matches: boolean }) => void> = [];
let prefersDark = true;

vi.stubGlobal("matchMedia", (query: string) => ({
  // A getter, not a value: the store resolves the query once at module scope
  // and reads `.matches` later, exactly as a real MediaQueryList behaves.
  get matches() {
    return query.includes("dark") ? prefersDark : !prefersDark;
  },
  media: query,
  addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
    mediaListeners.push(fn);
  },
  removeEventListener: () => {},
}));

const { useThemeStore } = await import("./themeStore");

beforeEach(() => {
  vi.clearAllMocks();
  // NOT reset between tests: the store binds its OS listener exactly once per
  // module lifetime (see `systemListenerBound`), so clearing this would leave
  // later tests with no handle on the one real listener. The handler reads
  // live store state, so it behaves correctly whichever test bound it.
  prefersDark = true;
  localStorage.clear();
  document.documentElement.style.cssText = "";
  useThemeStore.setState({
    theme: null,
    themes: [],
    loading: false,
    followingSystem: false,
  });
  ipcMock.listThemes.mockResolvedValue([ATELIER, VELLUM]);
  ipcMock.setTheme.mockResolvedValue(undefined);
});

afterEach(() => {
  document.documentElement.style.cssText = "";
});

describe("themeStore · stored choice vs system preference", () => {
  it("uses the stored theme and stops following the system", async () => {
    ipcMock.getTheme.mockResolvedValue(VELLUM);
    await useThemeStore.getState().load();

    expect(useThemeStore.getState().theme?.name).toBe("vellum");
    expect(useThemeStore.getState().followingSystem).toBe(false);
  });

  it("seeds vellum from prefers-color-scheme when nothing is stored", async () => {
    // The bug: load() defaulted to atelier regardless, so a light-desktop user
    // got onyx until they found the setting.
    prefersDark = false;
    ipcMock.getTheme.mockResolvedValue(null);
    await useThemeStore.getState().load();

    expect(useThemeStore.getState().theme?.name).toBe("vellum");
    expect(useThemeStore.getState().followingSystem).toBe(true);
  });

  it("seeds atelier when the desktop is dark", async () => {
    prefersDark = true;
    ipcMock.getTheme.mockResolvedValue(null);
    await useThemeStore.getState().load();

    expect(useThemeStore.getState().theme?.name).toBe("atelier");
  });

  it("never persists a seeded theme — that would freeze the preference", async () => {
    ipcMock.getTheme.mockResolvedValue(null);
    await useThemeStore.getState().load();

    expect(ipcMock.setTheme).not.toHaveBeenCalled();
  });

  it("repaints when the OS flips, but only while following it", async () => {
    prefersDark = true;
    ipcMock.getTheme.mockResolvedValue(null);
    await useThemeStore.getState().load();
    expect(useThemeStore.getState().theme?.name).toBe("atelier");

    mediaListeners.forEach((fn) => fn({ matches: false }));
    expect(useThemeStore.getState().theme?.name).toBe("vellum");
    expect(read("--color-octo-bg")).toBe(VELLUM.bg);

    // An explicit choice ends the tracking for good.
    await useThemeStore.getState().apply(ATELIER);
    expect(useThemeStore.getState().followingSystem).toBe(false);
    mediaListeners.forEach((fn) => fn({ matches: false }));
    expect(useThemeStore.getState().theme?.name).toBe("atelier");
  });

  it("an explicit choice is persisted", async () => {
    await useThemeStore.getState().apply(VELLUM);
    expect(ipcMock.setTheme).toHaveBeenCalledWith(VELLUM);
  });

  it("does not let an in-flight load overwrite a choice when a theme IS stored", async () => {
    // The returning-user half of the race: `stored` is non-null, so a guard
    // placed after the `if (stored)` branch would never run and last launch's
    // theme would clobber the click — and rewrite the pre-paint mirror with it,
    // carrying the wrong ground into the next launch too.
    let releaseGetTheme!: (v: ThemeConfig) => void;
    ipcMock.getTheme.mockReturnValue(
      new Promise<ThemeConfig>((resolve) => {
        releaseGetTheme = resolve;
      }),
    );

    const loading = useThemeStore.getState().load();
    await useThemeStore.getState().apply(VELLUM); // user picks mid-flight
    releaseGetTheme(ATELIER); // last launch's stored theme finally arrives
    await loading;

    expect(useThemeStore.getState().theme?.name).toBe("vellum");
    expect(useThemeStore.getState().followingSystem).toBe(false);
    expect(read("--color-octo-bg")).toBe(VELLUM.bg);
    expect(JSON.parse(localStorage.getItem("octo:theme")!).bg).toBe(VELLUM.bg);
  });

  it("does not let an in-flight load overwrite a choice made while it ran", async () => {
    // `stored` is a snapshot taken before the click. Seeding from it would
    // repaint over the user's pick AND switch OS-following back on, leaving
    // the listener free to overwrite the choice until restart.
    prefersDark = true;
    let releaseGetTheme!: (v: null) => void;
    ipcMock.getTheme.mockReturnValue(
      new Promise<null>((resolve) => {
        releaseGetTheme = resolve;
      }),
    );

    const loading = useThemeStore.getState().load();
    await useThemeStore.getState().apply(VELLUM); // user picks mid-flight
    releaseGetTheme(null);
    await loading;

    expect(useThemeStore.getState().theme?.name).toBe("vellum");
    expect(useThemeStore.getState().followingSystem).toBe(false);
    // The themes list still lands, so the picker is populated either way.
    expect(useThemeStore.getState().themes).toHaveLength(2);
  });
});

describe("themeStore · applyThemeToDom", () => {
  it("declares color-scheme so native controls follow the theme", async () => {
    // Previously a hardcoded <meta content="dark"> in index.html, which left
    // vellum with dark scrollbars, form controls and caret on cream.
    await useThemeStore.getState().apply(VELLUM);
    expect(read("color-scheme")).toBe("light");

    await useThemeStore.getState().apply(ATELIER);
    expect(read("color-scheme")).toBe("dark");
  });

  it("publishes the interactive boundary separately from the hairline", async () => {
    await useThemeStore.getState().apply(VELLUM);
    expect(read("--color-octo-hairline")).toBe(VELLUM.border);
    expect(read("--color-octo-border-strong")).toBe(VELLUM.borderStrong);
    expect(read("--color-octo-border-strong")).not.toBe(read("--color-octo-hairline"));
  });

  it("derives status alphas from the active theme, not the atelier palette", async () => {
    // The bug this guards: --verdigris-ghost and friends were frozen at the
    // dark theme's hues, so vellum tinted rows with colours from a theme the
    // user wasn't running.
    await useThemeStore.getState().apply(VELLUM);
    // #246f47 -> 36, 111, 71
    expect(read("--verdigris-ghost")).toBe("rgba(36, 111, 71, 0.08)");
    // #b33024 -> 179, 48, 36
    expect(read("--rouge-border")).toBe("rgba(179, 48, 36, 0.3)");
    // #7f5300 -> 127, 83, 0
    expect(read("--warning-ghost")).toBe("rgba(127, 83, 0, 0.08)");
    // The scrim composites over the canvas, so it must be the theme's own bg.
    expect(read("--onyx-40")).toBe("rgba(242, 236, 224, 0.4)");
  });

  it("thickens --brass-line on light themes so The Octo's back arms survive", async () => {
    await useThemeStore.getState().apply(ATELIER);
    expect(read("--brass-line")).toBe("rgba(212, 165, 116, 0.55)");

    await useThemeStore.getState().apply(VELLUM);
    expect(read("--brass-line")).toBe("rgba(145, 82, 44, 0.75)");
  });

  it("solves the diff tints per theme instead of freezing atelier's alpha", async () => {
    await useThemeStore.getState().apply(ATELIER);
    // Atelier's addition tint is unchanged; its deletion tint gains a step,
    // because rouge and verdigris do not share a luminance and a flat 0.08
    // therefore rendered them at different weights.
    expect(read("--diff-add-bg")).toBe("rgba(143, 201, 168, 0.08)");
    expect(read("--diff-del-bg")).toBe("rgba(209, 139, 139, 0.09)");

    await useThemeStore.getState().apply(VELLUM);
    expect(read("--diff-add-bg")).toBe("rgba(36, 111, 71, 0.08)");
    expect(read("--diff-del-bg")).toBe("rgba(179, 48, 36, 0.075)");
  });

  it("mirrors an explicitly chosen theme to localStorage for the pre-paint script", async () => {
    // index.html reads this synchronously to avoid a dark flash on launch.
    await useThemeStore.getState().apply(VELLUM);
    const mirror = JSON.parse(localStorage.getItem("octo:theme")!);
    expect(mirror).toEqual({
      bg: VELLUM.bg,
      panel: VELLUM.panel,
      text: VELLUM.text,
      dark: false,
    });

    await useThemeStore.getState().apply(ATELIER);
    expect(JSON.parse(localStorage.getItem("octo:theme")!).dark).toBe(true);
  });

  it("clears the mirror while following the OS, so a stale one cannot outrank it", async () => {
    // The mirror outranks matchMedia in the pre-paint script. If a SEEDED
    // theme left one behind, a user who never chose a theme and flips their
    // desktop to light overnight would be painted last night's onyx on the
    // next launch — the exact flash the mirror exists to remove.
    await useThemeStore.getState().apply(ATELIER); // writes a mirror
    expect(localStorage.getItem("octo:theme")).not.toBeNull();

    prefersDark = false;
    ipcMock.getTheme.mockResolvedValue(null);
    useThemeStore.setState({ theme: null, followingSystem: false });
    await useThemeStore.getState().load();

    expect(useThemeStore.getState().followingSystem).toBe(true);
    expect(localStorage.getItem("octo:theme")).toBeNull();
  });

  it("still applies the theme when localStorage is unavailable", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(useThemeStore.getState().apply(VELLUM)).resolves.toBeUndefined();
    expect(read("--color-octo-bg")).toBe(VELLUM.bg);
    spy.mockRestore();
  });

  it("notifies the surfaces that cannot read CSS variables", async () => {
    const onTheme = vi.fn();
    window.addEventListener("octo:theme", onTheme);
    await useThemeStore.getState().apply(VELLUM);
    expect(onTheme).toHaveBeenCalledTimes(1);
    window.removeEventListener("octo:theme", onTheme);
  });
});

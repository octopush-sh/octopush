import { describe, expect, it, vi } from "vitest";
// Vite serves the doc as a string; no Node fs under the app tsconfig.
import features from "../../docs/FEATURES.md?raw";
import type { WorkspaceMode } from "../lib/modes";
import { GLOBAL_SHORTCUTS, handleShortcut, matchShortcut, type ShortcutContext } from "./useGlobalShortcuts";

interface Press {
  key: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  defaultPrevented?: boolean;
}

function press(p: Press) {
  const e = {
    key: p.key,
    code: p.code ?? "",
    metaKey: p.meta ?? !p.ctrl,
    ctrlKey: p.ctrl ?? false,
    shiftKey: p.shift ?? false,
    altKey: p.alt ?? false,
    defaultPrevented: p.defaultPrevented ?? false,
    preventDefault: vi.fn(),
  };
  return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function ctx(over: Partial<ShortcutContext> & { modeNow?: WorkspaceMode } = {}): ShortcutContext {
  const { modeNow = "talk", ...rest } = over;
  return {
    mode: () => modeNow,
    workspaceIds: ["w1", "w2"],
    activeWorkspaceId: "w1",
    hasProject: true,
    selectWorkspace: vi.fn(),
    setMode: vi.fn(),
    toggleMissionControl: vi.fn(),
    toggleLogbook: vi.fn(),
    activeEditorPath: () => "/repo/src/a.ts",
    revealInTree: vi.fn(),
    openCreator: vi.fn(),
    togglePalette: vi.fn(),
    openSearch: vi.fn(),
    bumpLayout: vi.fn(),
    openSettings: vi.fn(),
    toggleSessionSwitcher: vi.fn(),
    terminalIds: () => ["t1", "t2", "t3"],
    activeTerminalId: () => "t1",
    setActiveTerminal: vi.fn(),
    ...rest,
  };
}

const idOf = (p: Press) => matchShortcut(press(p))?.id ?? null;

describe("matchShortcut", () => {
  it.each<[Press, string | null]>([
    [{ key: "1" }, "workspace-n"],
    [{ key: "9" }, "workspace-n"],
    [{ key: "1", ctrl: true }, "workspace-n"],
    [{ key: "0" }, null],
    [{ key: "1", shift: true }, "mode-talk-run-review"],
    [{ key: "!", shift: true }, "mode-talk-run-review"],
    [{ key: "#", shift: true, alt: true }, "mode-talk-run-review"],
    [{ key: "D", shift: true }, "mode-direct"],
    [{ key: "m", shift: true }, "mission-control"],
    [{ key: "L", shift: true }, "logbook"],
    [{ key: "E", shift: true }, "reveal-in-tree"],
    [{ key: "n" }, "new-workspace"],
    [{ key: "n", alt: true }, "new-workspace"],
    [{ key: "N", shift: true }, null],
    [{ key: "k" }, "palette"],
    [{ key: "p" }, "file-finder"],
    [{ key: "F", shift: true }, "text-search"],
    [{ key: "\\" }, "companion"],
    [{ key: "\\", shift: true, alt: true }, "companion"],
    [{ key: "," }, "settings"],
    [{ key: "T", shift: true }, "settings-usage"],
    [{ key: "t" }, null],
    [{ key: "k", alt: true }, "session-switcher"],
    // Option remapped the printed character; the physical key still counts.
    [{ key: "˚", code: "KeyK", alt: true }, "session-switcher"],
    [{ key: "k", alt: true, shift: true }, null],
    [{ key: "ArrowLeft", alt: true }, "session-step"],
    [{ key: "ArrowRight", alt: true }, "session-step"],
    [{ key: "ArrowRight" }, null],
    // macOS: ⌘⌥1 prints "¡" — the code decides.
    [{ key: "¡", code: "Digit1", alt: true }, "session-n"],
    [{ key: "3", alt: true }, "session-n"],
    [{ key: "1", alt: true, shift: true }, "mode-talk-run-review"],
  ])("%o → %s", (p, id) => {
    expect(idOf(p)).toBe(id);
  });

  it("needs ⌘ or Ctrl", () => {
    expect(idOf({ key: "k", meta: false })).toBeNull();
    expect(idOf({ key: "1", meta: false, alt: true, code: "Digit1" })).toBeNull();
  });

  it("gives every shortcut a unique id", () => {
    const ids = GLOBAL_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("handleShortcut", () => {
  it("ignores a key something closer already handled", () => {
    const c = ctx();
    const e = press({ key: "L", shift: true, defaultPrevented: true });
    handleShortcut(e, c);
    expect(c.toggleLogbook).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("switches to workspace N, and leaves the key alone when there is none", () => {
    const c = ctx();
    const e = press({ key: "2" });
    handleShortcut(e, c);
    expect(c.selectWorkspace).toHaveBeenCalledWith("w2");
    expect(e.preventDefault).toHaveBeenCalled();

    const none = press({ key: "5" });
    handleShortcut(none, c);
    expect(none.preventDefault).not.toHaveBeenCalled();
  });

  it.each<[string, WorkspaceMode]>([
    ["1", "talk"], ["!", "talk"], ["2", "run"], ["@", "run"], ["3", "review"], ["#", "review"],
  ])("⌘⇧%s → %s", (key, mode) => {
    const c = ctx();
    handleShortcut(press({ key, shift: true }), c);
    expect(c.setMode).toHaveBeenCalledWith(mode);
  });

  it("runs the plain global shortcuts", () => {
    const c = ctx();
    handleShortcut(press({ key: "d", shift: true }), c);
    expect(c.setMode).toHaveBeenCalledWith("direct");
    handleShortcut(press({ key: "M", shift: true }), c);
    expect(c.toggleMissionControl).toHaveBeenCalled();
    handleShortcut(press({ key: "k" }), c);
    expect(c.togglePalette).toHaveBeenCalled();
    handleShortcut(press({ key: "p" }), c);
    expect(c.openSearch).toHaveBeenCalledWith("files");
    handleShortcut(press({ key: "f", shift: true }), c);
    expect(c.openSearch).toHaveBeenCalledWith("text");
    handleShortcut(press({ key: "\\" }), c);
    expect(c.bumpLayout).toHaveBeenCalled();
    handleShortcut(press({ key: "," }), c);
    expect(c.openSettings).toHaveBeenCalledWith("general");
    handleShortcut(press({ key: "t", shift: true }), c);
    expect(c.openSettings).toHaveBeenCalledWith("usage");
  });

  it("claims ⌘N even without a project, but opens the creator only with one", () => {
    const without = ctx({ hasProject: false });
    const e = press({ key: "n" });
    handleShortcut(e, without);
    expect(without.openCreator).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();

    const c = ctx();
    handleShortcut(press({ key: "n" }), c);
    expect(c.openCreator).toHaveBeenCalled();
  });

  it("reveals the open file only in Review, and claims ⌘⇧E everywhere", () => {
    const talk = ctx();
    const e = press({ key: "e", shift: true });
    handleShortcut(e, talk);
    expect(talk.revealInTree).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();

    const review = ctx({ modeNow: "review" });
    handleShortcut(press({ key: "E", shift: true }), review);
    expect(review.revealInTree).toHaveBeenCalledWith("/repo/src/a.ts");

    const noFile = ctx({ modeNow: "review", activeEditorPath: () => null });
    handleShortcut(press({ key: "E", shift: true }), noFile);
    expect(noFile.revealInTree).not.toHaveBeenCalled();
  });

  describe("Run-mode session shortcuts", () => {
    it("do nothing outside Run and leave the key alone", () => {
      const c = ctx({ modeNow: "talk" });
      for (const p of [
        { key: "k", alt: true },
        { key: "ArrowRight", alt: true },
        { key: "¡", code: "Digit1", alt: true },
      ]) {
        const e = press(p);
        handleShortcut(e, c);
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
      expect(c.toggleSessionSwitcher).not.toHaveBeenCalled();
      expect(c.setActiveTerminal).not.toHaveBeenCalled();
    });

    it("⌘⌥K toggles the switcher, needing a workspace", () => {
      const c = ctx({ modeNow: "run" });
      const e = press({ key: "˚", code: "KeyK", alt: true });
      handleShortcut(e, c);
      expect(c.toggleSessionSwitcher).toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();

      const none = ctx({ modeNow: "run", activeWorkspaceId: null });
      const e2 = press({ key: "k", alt: true });
      handleShortcut(e2, none);
      expect(none.toggleSessionSwitcher).not.toHaveBeenCalled();
      expect(e2.preventDefault).not.toHaveBeenCalled();
    });

    it("⌘⌥←/→ step through sessions, wrapping", () => {
      const c = ctx({ modeNow: "run" });
      handleShortcut(press({ key: "ArrowLeft", alt: true }), c);
      expect(c.setActiveTerminal).toHaveBeenLastCalledWith("t3");
      handleShortcut(press({ key: "ArrowRight", alt: true }), c);
      expect(c.setActiveTerminal).toHaveBeenLastCalledWith("t2");

      const last = ctx({ modeNow: "run", activeTerminalId: () => "t3" });
      handleShortcut(press({ key: "ArrowRight", alt: true }), last);
      expect(last.setActiveTerminal).toHaveBeenLastCalledWith("t1");
    });

    it("⌘⌥←/→ leave the key alone with fewer than two sessions", () => {
      const c = ctx({ modeNow: "run", terminalIds: () => ["t1"] });
      const e = press({ key: "ArrowRight", alt: true });
      handleShortcut(e, c);
      expect(c.setActiveTerminal).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("⌘⌥N jumps to the Nth session by physical key", () => {
      const c = ctx({ modeNow: "run" });
      const e = press({ key: "™", code: "Digit2", alt: true });
      handleShortcut(e, c);
      expect(c.setActiveTerminal).toHaveBeenCalledWith("t2");
      expect(e.preventDefault).toHaveBeenCalled();

      const beyond = press({ key: "9", alt: true });
      handleShortcut(beyond, c);
      expect(c.setActiveTerminal).toHaveBeenCalledTimes(1);
      expect(beyond.preventDefault).toHaveBeenCalled();
    });

    it("⌘⌥N never switches workspace", () => {
      const c = ctx({ modeNow: "run" });
      handleShortcut(press({ key: "1", alt: true }), c);
      expect(c.selectWorkspace).not.toHaveBeenCalled();
      expect(c.setActiveTerminal).toHaveBeenCalledWith("t1");
    });
  });
});

describe("FEATURES.md Appendix C", () => {
  const start = features.indexOf("## Appendix C");
  const appendix = features.slice(start, features.indexOf("\n## ", start + 1));

  it("lists every global shortcut's key caps", () => {
    expect(start).toBeGreaterThan(-1);
    const missing = GLOBAL_SHORTCUTS.flatMap((s) => s.chords).filter(
      (chord) => !appendix.includes("`" + chord + "`"),
    );
    expect(missing).toEqual([]);
  });

  it("names the module that owns them", () => {
    expect(appendix).toContain("src/hooks/useGlobalShortcuts.ts");
  });
});

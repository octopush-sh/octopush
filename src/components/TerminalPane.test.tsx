/**
 * Tests for TerminalPane.
 *
 * xterm.js requires a browser canvas environment that JSDOM does not provide,
 * so we mock the @xterm/xterm and @xterm/addon-fit packages entirely.
 * This lets us verify:
 *   - onSpawn fires after the PTY session is created.
 *   - onExit fires when the pty://exit event matches this terminal's session.
 *   - The wrapper div has display:none when visible===false and display:block when true.
 *
 * NOTE: xterm DOM-rendering behaviour (canvas, scroll, font) is skipped here
 * because it requires a real browser environment. Verify those in Playwright/e2e.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// ─── JSDOM shims ──────────────────────────────────────────────────
// ResizeObserver is not available in JSDOM.
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});

// requestAnimationFrame is present in JSDOM but behaves differently — stub it
// so frame callbacks run immediately (avoids timing issues in tests).
Object.defineProperty(globalThis, "requestAnimationFrame", {
  writable: true,
  value: (cb: FrameRequestCallback) => { cb(0); return 0; },
});

// ─── Mock @xterm/xterm ────────────────────────────────────────────
// NOTE: Must use class (constructor), not arrow function, because the component
// uses `new Terminal(...)` which requires a constructable function.

const xtermHoisted = vi.hoisted(() => ({
  last: null as unknown as {
    getSelection: ReturnType<typeof vi.fn>;
    options: { fontSize: number; altClickMovesCursor: boolean };
    /** What xterm's `term.modes` reports — set by tests to simulate a program
     *  that turned mouse tracking on. */
    modes: { mouseTrackingMode: string };
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    /** OSC handlers the component registered, by identifier (52 = clipboard). */
    oscHandlers: Record<number, (data: string) => boolean>;
    /** The `term.onData` callback — what a keystroke or mouse report invokes. */
    dataHandler: ((data: string) => void) | null;
    /** The options passed to `new Terminal(...)`. */
    ctorOptions: Record<string, unknown>;
  } | null,
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    ctorOptions: Record<string, unknown>;
    oscHandlers: Record<number, (data: string) => boolean> = {};
    dataHandler: ((data: string) => void) | null = null;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataHandler = cb;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onBell = vi.fn(() => ({ dispose: vi.fn() }));
    writeln = vi.fn();
    // xterm runs a write's callback once that chunk has been parsed; the
    // default mock "parses" instantly. Tests that need a chunk to stay
    // pending override the implementation.
    write = vi.fn((_data: unknown, cb?: () => void) => {
      cb?.();
    });
    focus = vi.fn();
    dispose = vi.fn();
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    // Real xterm routes `input(data, true)` through onData, like a keystroke.
    input = vi.fn((data: string) => {
      this.dataHandler?.(data);
    });
    parser = {
      registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
        this.oscHandlers[ident] = cb;
        return { dispose: vi.fn() };
      }),
    };
    options = { fontSize: 13, altClickMovesCursor: true };
    modes = { mouseTrackingMode: "none" };
    constructor(opts: Record<string, unknown>) {
      this.ctorOptions = opts;
      xtermHoisted.last = this;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class WebLinksAddon {}
  return { WebLinksAddon };
});

// ─── Mock Tauri event listener ────────────────────────────────────

type EventCallback<T> = (ev: { payload: T }) => void;
const eventListeners: Record<string, EventCallback<unknown>[]> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, cb: EventCallback<unknown>) =>
      new Promise<() => void>((resolve) => {
        if (!eventListeners[event]) eventListeners[event] = [];
        eventListeners[event].push(cb);
        resolve(() => {
          eventListeners[event] = eventListeners[event].filter((fn) => fn !== cb);
        });
      }),
  ),
}));

function emitEvent<T>(event: string, payload: T) {
  (eventListeners[event] ?? []).forEach((cb) => cb({ payload }));
}

// ─── Mock IPC ─────────────────────────────────────────────────────

// Phase 3: TerminalPane uses spawnOrAttachTerminal instead of createSession.
// The PTY session id is now the terminalId prop itself (not a new UUID).
type SpawnOrAttachResult =
  | { mode: "Spawned"; pid: number }
  | { mode: "Reattached" };

const mockIpc = {
  spawnOrAttachTerminal: vi.fn(
    (_id: string, _cwd: string, _label: string): Promise<SpawnOrAttachResult> =>
      Promise.resolve({ mode: "Spawned", pid: 12345 }),
  ),
  killSession: vi.fn(() => Promise.resolve()),
  resizeSession: vi.fn(() => Promise.resolve()),
  writeTextToSession: vi.fn(() => Promise.resolve()),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

// ─── Mock toasts ──────────────────────────────────────────────────
// `copyToClipboard` announces program-initiated copies through pushToast.
const toastsMock = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("./Toasts", () => ({ pushToast: toastsMock.pushToast }));

// ─── Import component after mocks ─────────────────────────────────

const { TerminalPane } = await import("./TerminalPane");

// ─── Tests ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset event listeners between tests.
  Object.keys(eventListeners).forEach((k) => delete eventListeners[k]);
  mockIpc.spawnOrAttachTerminal.mockResolvedValue({ mode: "Spawned", pid: 12345 });
});

describe("TerminalPane — clipboard", () => {
  it("copies the xterm selection to the clipboard on right-click", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(
      <TerminalPane terminalId="tc" workspaceId="ws" workspacePath="/p" label="L" visible={true} />,
    );
    await act(async () => { await Promise.resolve(); });

    // Selection is non-empty → right-click copies it and suppresses the
    // browser's "copy word under cursor".
    xtermHoisted.last!.getSelection.mockReturnValue("selected text");
    const el = container.querySelector(".xterm-container") as HTMLElement;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);

    expect(writeText).toHaveBeenCalledWith("selected text");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not copy or preventDefault when there is no selection", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(
      <TerminalPane terminalId="tc2" workspaceId="ws" workspacePath="/p" label="L" visible={true} />,
    );
    await act(async () => { await Promise.resolve(); });

    xtermHoisted.last!.getSelection.mockReturnValue("");
    const el = container.querySelector(".xterm-container") as HTMLElement;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);

    expect(writeText).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

// ─── OSC 52 ───────────────────────────────────────────────────────
// `ESC ] 52 ; Pc ; Pd ST`: a program in the PTY asks the terminal to put
// base64(Pd) on the clipboard. The gate's mechanics are proven against the
// real xterm in lib/osc52.test.ts; here we check the pane's wiring and its
// policy, driving the registered handler with the body xterm would pass it
// (`Pc;Pd`).

/** What a program sends: base64 of the UTF-8 bytes. */
function osc52(text: string, pc = "c"): string {
  let bin = "";
  new TextEncoder().encode(text).forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return `${pc};${btoa(bin)}`;
}

async function mountForOsc(id: string, visible = true) {
  const writeText = vi.fn();
  Object.assign(navigator, { clipboard: { writeText } });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(
    <TerminalPane terminalId={id} workspaceId="ws" workspacePath="/p" label="L" visible={visible} />,
  );
  await act(async () => { await Promise.resolve(); });
  const term = xtermHoisted.last!;
  const handler = term.oscHandlers[52];
  expect(handler).toBeTypeOf("function");
  return { writeText, term, handler };
}

describe("TerminalPane — OSC 52", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies a program's payload as UTF-8 from live output, consumes the sequence, and says so", async () => {
    const { writeText, handler } = await mountForOsc("osc1");
    emitEvent("pty://data", { sessionId: "osc1", bytes: [0x41] }); // live output
    expect(handler(osc52("información — Móvil ✓"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("información — Móvil ✓");
    // Nothing was pressed in Octopush, so the copy is announced.
    await vi.waitFor(() =>
      expect(toastsMock.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ level: "success", title: "Copied from the terminal" }),
      ),
    );
  });

  it("never copies while replayed scrollback is still being parsed", async () => {
    const { writeText, term, handler } = await mountForOsc("osc2");
    const pending: Array<() => void> = [];
    term.write.mockImplementation((_data: unknown, cb?: () => void) => {
      if (cb) pending.push(cb);
    });

    // The backend tags the replay; a live chunk queued behind it carries no
    // callback and never holds the gate by itself.
    emitEvent("pty://data", { sessionId: "osc2", bytes: [0x1b, 0x5d], replay: true });
    emitEvent("pty://data", { sessionId: "osc2", bytes: [0x41] });
    expect(pending).toHaveLength(1);

    // xterm is inside the replayed chunk → this OSC 52 is history → ignored.
    expect(handler(osc52("stale"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    // xterm finished the replay → the live chunk's OSC 52 may copy.
    pending[0]();
    expect(handler(osc52("fresh"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("fresh");
  });

  it("stays shut on a pane whose every chunk is history (a daemon that never marks the replay done)", async () => {
    const { writeText, term, handler } = await mountForOsc("osc3");
    const pending: Array<() => void> = [];
    term.write.mockImplementation((_data: unknown, cb?: () => void) => {
      if (cb) pending.push(cb);
    });
    emitEvent("pty://data", { sessionId: "osc3", bytes: [0x41], replay: true });
    expect(handler(osc52("one"))).toBe(true);
    pending.shift()!();
    emitEvent("pty://data", { sessionId: "osc3", bytes: [0x42], replay: true });
    expect(handler(osc52("two"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("swallows queries, clears and malformed payloads without touching the clipboard", async () => {
    const { writeText, handler } = await mountForOsc("osc4");
    expect(handler("c;?")).toBe(true); // a read request: never answered
    expect(handler("c;")).toBe(true);
    expect(handler("c;%%%not-base64")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores OSC 52 from a pane that is not on screen", async () => {
    const { writeText, handler } = await mountForOsc("osc5", false);
    expect(handler(osc52("hidden"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores OSC 52 while the Octopush window is not focused", async () => {
    const { writeText, handler } = await mountForOsc("osc6");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(handler(osc52("background"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane — native selection override", () => {
  it("lets Option-drag force a native xterm selection while a program owns the mouse", async () => {
    render(
      <TerminalPane terminalId="sel1" workspaceId="ws" workspacePath="/p" label="L" visible={true} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(xtermHoisted.last!.ctorOptions.macOptionClickForcesSelection).toBe(true);
  });

  it("switches alt-click cursor moves off only while a program tracks the mouse", async () => {
    const { container } = render(
      <TerminalPane terminalId="sel2" workspaceId="ws" workspacePath="/p" label="L" visible={true} />,
    );
    await act(async () => { await Promise.resolve(); });
    const term = xtermHoisted.last!;
    const el = container.querySelector(".xterm-container") as HTMLElement;

    // A TUI turned mouse tracking on: an Option+click must not become a
    // burst of arrow keys into the program.
    term.modes.mouseTrackingMode = "any";
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, altKey: true }));
    expect(term.options.altClickMovesCursor).toBe(false);

    // Back at a plain prompt the shell feature is restored.
    term.modes.mouseTrackingMode = "none";
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, altKey: true }));
    expect(term.options.altClickMovesCursor).toBe(true);
  });
});

describe("TerminalPane — zoom", () => {
  // Helper: grab the custom key-event handler the component registered.
  function keyHandler() {
    const calls = xtermHoisted.last!.attachCustomKeyEventHandler.mock.calls;
    return calls[0][0] as (e: Partial<KeyboardEvent>) => boolean;
  }

  async function mounted() {
    const { container } = render(
      <TerminalPane terminalId="tz" workspaceId="ws" workspacePath="/p" label="L" visible={true} />,
    );
    await act(async () => { await Promise.resolve(); });
    return container;
  }

  it("increases font size on Cmd/Ctrl + and resets on Cmd/Ctrl 0", async () => {
    await mounted();
    const handler = keyHandler();

    const inc = { type: "keydown", metaKey: true, key: "=", preventDefault: vi.fn() };
    expect(handler(inc)).toBe(false);
    expect(inc.preventDefault).toHaveBeenCalled();
    expect(xtermHoisted.last!.options.fontSize).toBe(14);

    const reset = { type: "keydown", metaKey: true, key: "0", preventDefault: vi.fn() };
    expect(handler(reset)).toBe(false);
    expect(xtermHoisted.last!.options.fontSize).toBe(13);
  });

  it("decreases font size on Cmd/Ctrl - and clamps at the minimum", async () => {
    await mounted();
    const handler = keyHandler();
    // Drive well past the floor; size must clamp, not go below ZOOM_MIN (8).
    for (let i = 0; i < 20; i++) {
      handler({ type: "keydown", ctrlKey: true, key: "-", preventDefault: vi.fn() });
    }
    expect(xtermHoisted.last!.options.fontSize).toBe(8);
  });

  it("does not treat a plain '=' keystroke as zoom", async () => {
    await mounted();
    const handler = keyHandler();
    const ev = { type: "keydown", key: "=", preventDefault: vi.fn() };
    expect(handler(ev)).toBe(true); // forwarded to the PTY
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(xtermHoisted.last!.options.fontSize).toBe(13);
  });

  it("sends Option+Left as a word jump (xterm 5's mapping, gone in xterm 6)", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      await mounted();
      const handler = keyHandler();
      const ev = { type: "keydown", altKey: true, key: "ArrowLeft", preventDefault: vi.fn() };
      expect(handler(ev)).toBe(false); // handled — xterm must not also encode it
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(xtermHoisted.last!.input).toHaveBeenCalledWith("\x1bb", true);
      // A plain arrow is left to xterm.
      expect(handler({ type: "keydown", key: "ArrowLeft", preventDefault: vi.fn() })).toBe(true);
    } finally {
      platform.mockRestore();
    }
  });

  it("zooms with Ctrl + mouse wheel", async () => {
    const container = await mounted();
    const el = container.querySelector(".xterm-container") as HTMLElement;

    const up = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1 });
    el.dispatchEvent(up);
    expect(xtermHoisted.last!.options.fontSize).toBe(14);
    expect(up.defaultPrevented).toBe(true);

    const down = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 1 });
    el.dispatchEvent(down);
    expect(xtermHoisted.last!.options.fontSize).toBe(13);

    // Without Ctrl, the wheel scrolls normally and font size is untouched.
    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 });
    el.dispatchEvent(plain);
    expect(xtermHoisted.last!.options.fontSize).toBe(13);
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe("TerminalPane — spawn callback", () => {
  it("calls onSpawn after spawnOrAttachTerminal resolves", async () => {
    const onSpawn = vi.fn();
    render(
      <TerminalPane
        terminalId="t1"
        workspaceId="ws-test"
        workspacePath="/path/to/ws"
        label="Main"
        visible={true}
        onSpawn={onSpawn}
      />,
    );

    // Wait for the spawnOrAttachTerminal promise to resolve.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockIpc.spawnOrAttachTerminal).toHaveBeenCalledWith(
      "t1",
      "/path/to/ws",
      "Main",
    );
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it("does not call onSpawn if the component unmounts before spawn resolves", async () => {
    let resolveCreate!: (v: { mode: "Spawned"; pid: number }) => void;
    mockIpc.spawnOrAttachTerminal.mockReturnValueOnce(
      new Promise<{ mode: "Spawned"; pid: number }>((res) => {
        resolveCreate = res;
      }),
    );

    const onSpawn = vi.fn();
    const { unmount } = render(
      <TerminalPane
        terminalId="t-unmount"
        workspaceId="ws-test"
        workspacePath="/ws"
        label="Temp"
        visible={true}
        onSpawn={onSpawn}
      />,
    );

    // Unmount before spawn resolves.
    unmount();

    await act(async () => {
      resolveCreate({ mode: "Spawned", pid: 99 });
      await Promise.resolve();
    });

    expect(onSpawn).not.toHaveBeenCalled();
  });
});

describe("TerminalPane — exit callback", () => {
  it("calls onExit when pty://exit event fires for this session", async () => {
    const onExit = vi.fn();
    render(
      <TerminalPane
        terminalId="t-exit"
        workspaceId="ws-test"
        workspacePath="/ws"
        label="Main"
        visible={true}
        onExit={onExit}
      />,
    );

    // Let the event listener attach and spawn resolve.
    // The PTY session id is now the terminalId ("t-exit") directly.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      emitEvent("pty://exit", { sessionId: "t-exit", code: 0 });
    });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("ignores pty://exit events for other sessions", async () => {
    const onExit = vi.fn();
    render(
      <TerminalPane
        terminalId="t-exit-other"
        workspaceId="ws-test"
        workspacePath="/ws"
        label="Main"
        visible={true}
        onExit={onExit}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      emitEvent("pty://exit", { sessionId: "different-terminal-id", code: 0 });
    });

    expect(onExit).not.toHaveBeenCalled();
  });
});

describe("TerminalPane — visibility", () => {
  it("wrapper has display:none when visible is false", async () => {
    const { container } = render(
      <TerminalPane
        terminalId="t-hidden"
        workspaceId="ws-test"
        workspacePath="/ws"
        label="Main"
        visible={false}
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.display).toBe("none");
  });

  it("wrapper has display:block when visible is true", async () => {
    const { container } = render(
      <TerminalPane
        terminalId="t-visible"
        workspaceId="ws-test"
        workspacePath="/ws"
        label="Main"
        visible={true}
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.display).toBe("block");
  });
});

// NOTE: xterm DOM rendering (canvas output, font metrics, scroll position) is
// not tested here — JSDOM lacks the CanvasRenderingContext2D needed by xterm.
// Cover those interactions in Playwright end-to-end tests.

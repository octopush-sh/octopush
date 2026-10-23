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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
    options: { fontSize: number };
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
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
    parser = {
      registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
        this.oscHandlers[ident] = cb;
        return { dispose: vi.fn() };
      }),
    };
    options = { fontSize: 13 };
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
// base64(Pd) on the clipboard. The component registers for it through
// `term.parser.registerOscHandler(52, …)`; these tests drive that handler
// directly with the body xterm would pass it (`Pc;Pd`).

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
  it("copies a program's payload as UTF-8 once the pane has sent input, and consumes the sequence", async () => {
    const { writeText, term, handler } = await mountForOsc("osc1");

    // Output before any input (this is where replayed scrollback lands):
    // consumed, but never copied.
    expect(handler(osc52("stale"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    // The user's first gesture — a keystroke, or the mouse report a TUI gets
    // when they drag-select inside it — opens the gate.
    term.dataHandler!("x");
    expect(handler(osc52("información — Móvil ✓"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("información — Móvil ✓");
  });

  it("keeps the gate closed until every chunk queued before the first input has been parsed", async () => {
    const { writeText, term, handler } = await mountForOsc("osc2");
    const pending: Array<() => void> = [];
    term.write.mockImplementation((_data: unknown, cb?: () => void) => {
      if (cb) pending.push(cb);
    });

    // Replay arrives (queued before any input), then the user clicks.
    emitEvent("pty://data", { sessionId: "osc2", bytes: [0x1b, 0x5d] });
    term.dataHandler!("x");
    expect(pending).toHaveLength(1);

    // xterm is still parsing that pre-input chunk → still ignored.
    expect(handler(osc52("stale"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    // Chunks written after arming don't hold the gate.
    emitEvent("pty://data", { sessionId: "osc2", bytes: [0x41] });
    expect(pending).toHaveLength(1);

    // xterm finished the pre-input chunk → live output may copy.
    pending[0]();
    expect(handler(osc52("fresh"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("fresh");
  });

  it("swallows queries, clears and malformed payloads without touching the clipboard", async () => {
    const { writeText, term, handler } = await mountForOsc("osc3");
    term.dataHandler!("x");
    expect(handler("c;?")).toBe(true); // a read request: never answered
    expect(handler("c;")).toBe(true);
    expect(handler("c;%%%not-base64")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores OSC 52 from a pane that is not on screen", async () => {
    const { writeText, term, handler } = await mountForOsc("osc4", false);
    term.dataHandler!("x");
    expect(handler(osc52("hidden"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("closes the gate again on reattach so the replay cannot copy", async () => {
    const { writeText, term, handler } = await mountForOsc("osc5");
    term.dataHandler!("x");
    emitEvent("pty://reattached", { sessionId: "osc5" });
    expect(handler(osc52("replayed"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    term.dataHandler!("y");
    expect(handler(osc52("live"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("live");
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

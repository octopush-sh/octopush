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
  } | null,
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onBell = vi.fn(() => ({ dispose: vi.fn() }));
    writeln = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    options = { fontSize: 13 };
    constructor() {
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

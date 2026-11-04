/**
 * Tests for the Run canvas's SessionRail.
 *
 * The rail reads terminalsStore + attentionStore directly, so each test seeds
 * the stores and asserts on what the cell actually shows: the role icon, the
 * jump number under a held modifier, the busy edge, and the "this one rang"
 * marker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SessionRole } from "../../lib/sessionRole";

const mockIpc = {
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
  listPtySessions: vi.fn(),
};
vi.mock("../../lib/ipc", () => ({ ipc: mockIpc }));

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useAttentionStore } = await import("../../stores/attentionStore");
const { useTerminalLayoutStore } = await import("../../stores/terminalLayoutStore");
const { SessionRail } = await import("./SessionRail");

const WS = "ws-rail";
const noop = () => {};

type Seed = {
  id: string;
  label: string;
  role?: SessionRole;
  busy?: boolean;
  command?: string | null;
};

function seed(sessions: Seed[], activeId?: string) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: sessions.map((s, i) => ({
        id: s.id,
        label: s.label,
        position: i,
        running: true,
        busy: s.busy ?? false,
        restored: false,
        role: s.role ?? ("shell" as SessionRole),
        command: s.command ?? null,
      })),
    },
    activeByWs: { [WS]: activeId ?? sessions[0]?.id ?? null },
  });
}

beforeEach(() => {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {}, setupByTerminal: {} });
  useAttentionStore.setState({ flagsByWs: {} });
  vi.clearAllMocks();
});

describe("SessionRail — setup terminal", () => {
  it("says the setup is running, then marks a failure with its exit code", () => {
    seed([{ id: "s", label: "setup" }, { id: "m", label: "main" }]);
    useTerminalsStore.setState({ setupByTerminal: { s: { workspaceId: WS, status: "running", exitCode: null } } });
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.getByTestId("session-cell-s")).toHaveAttribute("aria-label", "setup — setup · running (⌘⌥1)");
    expect(screen.queryByTestId("session-setup-failed-s")).toBeNull();

    act(() => useTerminalsStore.getState().reportSetupExit(WS, "s", 1));
    expect(screen.getByTestId("session-cell-s")).toHaveAttribute("aria-label", "setup — setup failed · exit 1 (⌘⌥1)");
    expect(screen.getByTestId("session-setup-failed-s")).toHaveAttribute("title", "setup failed · exit 1");
    expect(screen.queryByTestId("session-setup-failed-m")).toBeNull();
  });
});

describe("SessionRail", () => {
  it("renders one cell per session, marking the active one", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "b");
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.getByTestId("session-cell-a")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("session-cell-b")).toHaveAttribute("aria-selected", "true");
  });

  it("names the session and what it is doing, without a second tooltip", () => {
    seed([{ id: "a", label: "dev", role: "dev", busy: true, command: "npm run dev" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    // Busy sessions report the live command; the jump shortcut rides along.
    // The name lives on aria-label, not `title` — the flyout opens on the same
    // hover and would otherwise be the second tooltip of one gesture.
    const cell = screen.getByTestId("session-cell-a");
    expect(cell).toHaveAttribute("aria-label", "dev — npm run dev (⌘⌥1)");
    expect(cell).not.toHaveAttribute("title");
  });

  it("says a busy session is running even when the command is unknown", () => {
    // An older daemon (or an unsupported platform) sends no command. Falling
    // back to the role phrase would have the cell claim "shell at the prompt"
    // while a build runs.
    seed([{ id: "a", label: "dev", busy: true, command: null }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.getByTestId("session-cell-a")).toHaveAttribute(
      "aria-label",
      "dev — running (⌘⌥1)",
    );
  });

  it("shows an icon at rest and the jump number while a modifier is held", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const cell = screen.getByTestId("session-cell-b");
    expect(cell.querySelector("svg")).toBeTruthy();
    expect(cell.textContent).toBe("");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    });
    expect(screen.getByTestId("session-cell-b").textContent).toBe("2");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    });
    expect(screen.getByTestId("session-cell-b").querySelector("svg")).toBeTruthy();
  });

  it("does not flash the numbers on a bare ⌘ — every ⌘ shortcut would", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    });
    expect(screen.getByTestId("session-cell-a").textContent).toBe("");
  });

  it("drops the peek when the window loses focus, so the rail can't stick", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    });
    expect(screen.getByTestId("session-cell-a").textContent).toBe("1");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByTestId("session-cell-a").textContent).toBe("");
  });

  it("marches the identity edge only while a command is running", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev", busy: true }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.queryByTestId("session-busy-a")).toBeNull();
    expect(screen.getByTestId("session-busy-b")).toHaveClass("rail-bar-running");
  });

  it("marks the session that rang — not every session in the workspace", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "b");
    });
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.getByTestId("session-bell-b")).toBeTruthy();
    expect(screen.queryByTestId("session-bell-a")).toBeNull();
  });

  it("never marks the session you are already looking at", () => {
    seed([{ id: "a", label: "main" }], "a");
    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "a");
    });
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.queryByTestId("session-bell-a")).toBeNull();
  });

  it("closes the flyout when focus leaves the cell", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const cell = screen.getByTestId("session-cell-a");
    fireEvent.focus(cell);
    expect(screen.getByTestId("session-flyout-a")).toBeTruthy();

    // Tab away: without this the popover stays parked over the terminal.
    fireEvent.blur(cell.parentElement!, {
      relatedTarget: screen.getByTestId("session-cell-b"),
    });
    expect(screen.queryByTestId("session-flyout-a")).toBeNull();
  });

  it("keeps the flyout through a scroll that leaves its cell in place, and drops it when the cell moves", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const wrapper = screen.getByTestId("session-cell-a").parentElement!;
    let top = 100;
    wrapper.getBoundingClientRect = () => ({ top, bottom: top + 32, left: 0, right: 32, width: 32, height: 32, x: 0, y: top, toJSON: () => ({}) });
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByTestId("session-flyout-a")).toBeTruthy();

    // A tour step's scrollIntoView on the flyout scrolls the list without
    // moving this cell: closing here detached the button it was about to click.
    const list = screen.getByRole("tablist");
    fireEvent.scroll(list);
    expect(screen.getByTestId("session-flyout-a")).toBeTruthy();

    top = 60;
    fireEvent.scroll(list);
    expect(screen.queryByTestId("session-flyout-a")).toBeNull();
  });

  it("lets the cell's rise-in let go of its transform, so the fixed flyout measures against the viewport", async () => {
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const css: string = fs.readFileSync("src/styles.css", "utf8");
    const rule = css.match(/\.octo-rise-in\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/\bbackwards\b/);
    expect(rule).not.toMatch(/\b(both|forwards)\b/);
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.getByTestId("session-cell-a").parentElement!.className).toContain("octo-rise-in");
  });

  it("keeps a rename alive when the pointer wanders off the cell", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const wrapper = screen.getByTestId("session-cell-a").parentElement!;
    fireEvent.mouseEnter(wrapper);
    fireEvent.click(screen.getByText("Rename"));
    fireEvent.change(screen.getByTestId("session-rename-a"), { target: { value: "logs" } });

    // Unmounting the input here would discard the typed label silently:
    // React fires no blur on unmount.
    fireEvent.mouseLeave(wrapper);
    expect(screen.getByTestId("session-rename-a")).toBeTruthy();
  });

  it("abandons a rename on Escape and rejects an empty one", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const wrapper = screen.getByTestId("session-cell-a").parentElement!;
    fireEvent.mouseEnter(wrapper);
    fireEvent.click(screen.getByText("Rename"));
    fireEvent.change(screen.getByTestId("session-rename-a"), { target: { value: "nope" } });
    fireEvent.keyDown(screen.getByTestId("session-rename-a"), { key: "Escape" });
    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Rename"));
    fireEvent.change(screen.getByTestId("session-rename-a"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByTestId("session-rename-a"), { key: "Enter" });
    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();
  });

  it("switches session on click", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    fireEvent.click(screen.getByTestId("session-cell-b"));
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
  });

  it("opens a session from the rail's own control", () => {
    seed([{ id: "a", label: "main" }]);
    mockIpc.createTerminal.mockResolvedValue({ id: "new", label: "Terminal 2", position: 1 });
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    fireEvent.click(screen.getByTestId("session-new"));
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(WS, "Terminal 2");
  });

  it("keeps rename and close reachable in the hover flyout", async () => {
    seed([{ id: "a", label: "main", role: "git" }]);
    mockIpc.renameTerminal.mockResolvedValue(undefined);
    mockIpc.deleteTerminal.mockResolvedValue(undefined);
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    fireEvent.mouseEnter(screen.getByTestId("session-cell-a").parentElement!);
    const flyout = screen.getByTestId("session-flyout-a");
    expect(flyout.textContent).toContain("main");
    expect(flyout.textContent).toContain("git");

    fireEvent.click(screen.getByText("Rename"));
    const input = screen.getByTestId("session-rename-a");
    fireEvent.change(input, { target: { value: "notes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("a", "notes");

    fireEvent.click(screen.getByTestId("session-close-a"));
    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("a");
  });

  it("moves focus with the arrow keys without switching session", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const first = screen.getByTestId("session-cell-a");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(document.activeElement).toBe(screen.getByTestId("session-cell-b"));
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");

    fireEvent.keyDown(screen.getByTestId("session-cell-b"), { key: "Enter" });
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
  });

  it("jumps focus to the ends with Home and End", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c", label: "tests" }], "a");
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const first = screen.getByTestId("session-cell-a");
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("session-cell-c"));

    fireEvent.keyDown(screen.getByTestId("session-cell-c"), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("session-cell-a"));
  });

  it("stays reachable by keyboard when no session is active", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    useTerminalsStore.setState((s) => ({ activeByWs: { ...s.activeByWs, [WS]: null } }));
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    expect(screen.getByTestId("session-cell-a")).toHaveAttribute("tabindex", "0");
  });
});

describe("SessionRail — sessions side by side", () => {
  beforeEach(() => useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, resizing: false }));

  it("marks a session shown in another pane with an ivory hairline and aria-current", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev", busy: true }, { id: "c", label: "tests" }]);
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b"], ratios: [0.5] })));
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);

    const a = screen.getByTestId("session-cell-a");
    const b = screen.getByTestId("session-cell-b");
    expect(a).toHaveAttribute("aria-selected", "true");
    expect(b).toHaveAttribute("aria-selected", "false");
    expect(a).toHaveAttribute("aria-current", "true");
    expect(b).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("session-cell-c")).not.toHaveAttribute("aria-current");
    // Watched, so the quiet hairline instead of the sage marching edge.
    expect(screen.getByTestId("session-shown-b").className).toContain("bg-octo-ivory");
    expect(screen.queryByTestId("session-busy-b")).toBeNull();
    expect(screen.queryByTestId("session-shown-a")).toBeNull();
  });

  it("the flyout's Open beside asks for the session to pair", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c", label: "tests" }]);
    const onOpenBeside = vi.fn();
    render(<SessionRail workspaceId={WS} onOpenBeside={onOpenBeside} />);
    // The demo's anchor sits on the focused session's cell, and only there.
    expect(screen.getByTestId("session-cell-a")).toHaveAttribute("data-tour", "run-session-cell");
    expect(document.querySelectorAll('[data-tour="run-session-cell"]')).toHaveLength(1);
    fireEvent.mouseEnter(screen.getByTestId("session-cell-b").parentElement!);
    const beside = screen.getByTestId("session-beside-b");
    expect(beside.textContent).toBe("Open beside");
    expect(beside).toHaveAttribute("title", "Choose a session to sit beside this one · ⌘D");
    fireEvent.click(beside);
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    // Choosing is the switcher's job: nothing is seated yet.
    expect(useTerminalLayoutStore.getState().getRun(WS).slots).toHaveLength(1);
  });

  it("reads Replace in the focused pane once Run has no room left", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c", label: "tests" }]);
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b"], ratios: [0.5] })));
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.mouseEnter(screen.getByTestId("session-cell-c").parentElement!);
    expect(screen.getByTestId("session-beside-c").textContent).toBe("Replace in the focused pane");
  });

  it("offers Open beside with every session on screen (it leaves a seat), not with no room", () => {
    seed([{ id: "a", label: "main" }]);
    const { unmount } = render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.mouseEnter(screen.getByTestId("session-cell-a").parentElement!);
    expect(screen.getByTestId("session-beside-a")).toBeTruthy();
    unmount();

    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b"], ratios: [0.5] })));
    render(<SessionRail workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.mouseEnter(screen.getByTestId("session-cell-a").parentElement!);
    expect(screen.queryByTestId("session-beside-a")).toBeNull();
  });
});

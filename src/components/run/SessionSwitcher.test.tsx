/**
 * Tests for the ⌘⌥K session switcher — the palette that answers "which
 * session do I want" when the rail's icons aren't enough.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
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
const { useTerminalLayoutStore } = await import("../../stores/terminalLayoutStore");
const { SessionSwitcher } = await import("./SessionSwitcher");

const WS = "ws-switcher";

function seed(
  sessions: Array<{ id: string; label: string; role?: SessionRole; busy?: boolean; command?: string }>,
  activeId?: string,
) {
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
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, talkByWs: {}, talkFocused: false });
  vi.clearAllMocks();
});

describe("SessionSwitcher — Talk's seat", () => {
  it("lists every session but the seat's own, Run's shown ones too, and seats the pick", () => {
    const onClose = vi.fn();
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c", label: "tests" }]);
    show(["a", "b"], 1);
    useTerminalLayoutStore.getState().seatTalkSession(WS, "c");
    const run = useTerminalLayoutStore.getState().getRun(WS);
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} talk />);

    expect(screen.getByPlaceholderText("Which session sits beside this one?")).toBeTruthy();
    expect(screen.queryByTestId("session-switcher-row-c")).toBeNull();
    expect(screen.getByTestId("session-switcher-row-a")).toBeTruthy();
    expect(screen.getByTestId("session-switcher-new").textContent).toBe("Open a new session beside");

    fireEvent.keyDown(screen.getByTestId("session-switcher-input"), { key: "Enter" });
    expect(useTerminalLayoutStore.getState().getTalk(WS)).toMatchObject({ terminalId: "a", open: true });
    // Run is untouched: same layout, same focused session.
    expect(useTerminalLayoutStore.getState().getRun(WS)).toBe(run);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
    expect(onClose).toHaveBeenCalled();
  });
});

/** Put `slots` on screen, focusing `focused`. */
function show(slots: (string | null)[], focused = 0) {
  useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots, focused }));
}
const slots = () => useTerminalLayoutStore.getState().getRun(WS).slots;
const FIVE = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: `Label ${id}` }));

describe("SessionSwitcher — pairing", () => {
  it("asks which session sits beside and lists only sessions not on screen", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c", label: "tests" }]);
    show(["a"]);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} pairing />);

    expect(screen.getByPlaceholderText("Which session sits beside this one?")).toBeTruthy();
    expect(screen.queryByTestId("session-switcher-row-a")).toBeNull();
    // Rows keep their rail number.
    expect(screen.getByTestId("session-switcher-row-c").textContent).toContain("3");
    expect(screen.getByTestId("session-switcher-new").textContent).toBe("Open a new session beside");
    expect(screen.queryByTestId("session-switcher-replaces")).toBeNull();
  });

  it("puts the pick in a new pane beside, then closes", () => {
    const onClose = vi.fn();
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    show(["a"]);
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} pairing />);

    fireEvent.keyDown(screen.getByTestId("session-switcher-input"), { key: "Enter" });
    expect(slots()).toEqual(["a", "b"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
    expect(onClose).toHaveBeenCalled();
  });

  it("says a pick replaces the focused pane when there is no room left", () => {
    seed(FIVE);
    show(["a", "b", "c"], 0);
    const { unmount } = render(<SessionSwitcher workspaceId={WS} onClose={() => {}} pairing />);
    // Three panes still have room for a fourth.
    expect(screen.queryByTestId("session-switcher-replaces")).toBeNull();
    unmount();

    show(["a", "b", "c", "d"], 0);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} pairing />);
    expect(screen.getByTestId("session-switcher-replaces").textContent).toBe(
      "Replaces the session in the focused pane",
    );
    fireEvent.click(screen.getByTestId("session-switcher-row-e"));
    expect(slots()).toEqual(["e", "b", "c", "d"]);
  });

  it("opens a new session straight into the empty seat", async () => {
    seed([{ id: "a", label: "main" }]);
    show(["a", null]);
    mockIpc.createTerminal.mockResolvedValue({ id: "new", label: "Terminal 2", position: 1 });
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} pairing />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("session-switcher-new"));
    });
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(WS, "Terminal 2");
    // The seat takes it; the pane that was focused still shows "a".
    expect(slots()).toEqual(["a", "new"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("new");
  });

  it("Escape closes the pairing switcher and leaves the layout alone", () => {
    const onClose = vi.fn();
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    show(["a"]);
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} pairing />);

    fireEvent.keyDown(screen.getByTestId("session-switcher-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(slots()).toEqual(["a"]);
    expect(useTerminalLayoutStore.getState().getRun(WS).focused).toBe(0);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");
  });

  it("still closes the selected session with Backspace on an empty query", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    show(["a"]);
    mockIpc.deleteTerminal.mockResolvedValue(undefined);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} pairing />);

    fireEvent.keyDown(screen.getByTestId("session-switcher-input"), { key: "Backspace" });
    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("b");
  });

  it("⌥⏎ in ⌘⌥K opens the selected session beside instead of switching", () => {
    const onClose = vi.fn();
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    show(["a"]);
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} />);

    const input = screen.getByTestId("session-switcher-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(slots()).toEqual(["a", "b"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("the ⌘⌥K footer says ⌥⏎ replaces once there is no room left", () => {
    seed(FIVE);
    show(["a"]);
    const { unmount } = render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);
    expect(screen.getByTestId("session-switcher-alt-hint").textContent).toBe("⌥⏎ · Beside");
    unmount();

    show(["a", "b", "c", "d"], 0);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);
    expect(screen.getByTestId("session-switcher-alt-hint").textContent).toBe("⌥⏎ · Replace");
    // The header line stays a pairing-mode thing.
    expect(screen.queryByTestId("session-switcher-replaces")).toBeNull();
    const input = screen.getByTestId("session-switcher-input");
    for (let i = 0; i < 4; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(slots()).toEqual(["e", "b", "c", "d"]);
  });
});

describe("SessionSwitcher", () => {
  it("lists every session with its number and what it is doing", () => {
    seed([
      { id: "a", label: "main", role: "git" },
      { id: "b", label: "dev", role: "dev", busy: true, command: "npm run dev" },
    ]);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    const rowA = screen.getByTestId("session-switcher-row-a");
    const rowB = screen.getByTestId("session-switcher-row-b");
    expect(rowA.textContent).toContain("main");
    expect(rowA.textContent).toContain("git");
    // A busy session shows the command itself rather than its role phrase.
    expect(rowB.textContent).toContain("npm run dev");
  });

  it("marks where you already are", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "b");
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    expect(screen.getByTestId("session-switcher-row-b").textContent).toContain("here");
    expect(screen.getByTestId("session-switcher-row-a").textContent).not.toContain("here");
  });

  it("filters on label, role and running command", () => {
    seed([
      { id: "a", label: "main", role: "git" },
      { id: "b", label: "dev", role: "dev", busy: true, command: "npm run dev" },
    ]);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("session-switcher-input"), { target: { value: "npm" } });
    expect(screen.queryByTestId("session-switcher-row-a")).toBeNull();
    expect(screen.getByTestId("session-switcher-row-b")).toBeTruthy();
  });

  it("switches with the arrow keys and Enter, then closes", () => {
    const onClose = vi.fn();
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} />);

    const input = screen.getByTestId("session-switcher-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes a session with Backspace, but only on an empty query", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    mockIpc.deleteTerminal.mockResolvedValue(undefined);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    const input = screen.getByTestId("session-switcher-input");
    fireEvent.change(input, { target: { value: "dev" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(mockIpc.deleteTerminal).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("a");
  });

  it("does not fire the same close twice on a fast double ⌫", async () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    // A delete that hasn't resolved yet still holds the row in the list, so a
    // second press would delete the same id and toast a failure for a session
    // that closed perfectly well.
    let resolve!: () => void;
    mockIpc.deleteTerminal.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    const input = screen.getByTestId("session-switcher-input");
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(mockIpc.deleteTerminal).toHaveBeenCalledTimes(1);

    resolve();
  });

  it("opens a new session from the last row", () => {
    seed([{ id: "a", label: "main" }]);
    mockIpc.createTerminal.mockResolvedValue({ id: "new", label: "Terminal 2", position: 1 });
    const onClose = vi.fn();
    render(<SessionSwitcher workspaceId={WS} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("session-switcher-new"));
    expect(mockIpc.createTerminal).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when nothing matches instead of showing an empty box", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionSwitcher workspaceId={WS} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("session-switcher-input"), { target: { value: "zzz" } });
    expect(screen.getByText("No session matches that.")).toBeTruthy();
  });
});

/**
 * Tests for the ⌘⌥K session switcher — the palette that answers "which
 * session do I want" when the rail's icons aren't enough.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  vi.clearAllMocks();
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

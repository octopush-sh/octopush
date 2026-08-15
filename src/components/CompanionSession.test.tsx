/**
 * Tests for the Run Companion's session inspector — the panel that replaced
 * the Terminals list once navigation moved to the canvas rail. Its job is to
 * keep every capability the list had (rename, close, the restored badge) while
 * answering what a 44px cell cannot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionRole } from "../lib/sessionRole";

const mockIpc = {
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
  listPtySessions: vi.fn(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useTerminalsStore } = await import("../stores/terminalsStore");
const { CompanionSession } = await import("./CompanionSession");

const WS = "ws-session";

function seed(
  sessions: Array<{
    id: string;
    label: string;
    role?: SessionRole;
    busy?: boolean;
    command?: string;
    running?: boolean;
    restored?: boolean;
  }>,
  activeId?: string,
) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: sessions.map((s, i) => ({
        id: s.id,
        label: s.label,
        position: i,
        running: s.running ?? true,
        busy: s.busy ?? false,
        restored: s.restored ?? false,
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

describe("CompanionSession", () => {
  it("describes the active session, not the whole list", () => {
    seed(
      [
        { id: "a", label: "main" },
        { id: "b", label: "dev", role: "dev", busy: true, command: "npm run dev" },
      ],
      "b",
    );
    render(<CompanionSession workspaceId={WS} />);

    expect(screen.getByTestId("session-detail-label").textContent).toBe("dev");
    expect(screen.getByText("dev server")).toBeTruthy();
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    // The panel describes one session — the rail is the list.
    expect(screen.queryByText("main")).toBeNull();
  });

  it("shows the jump shortcut for the session", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "b");
    render(<CompanionSession workspaceId={WS} />);
    expect(screen.getByText("⌘⌥2")).toBeTruthy();
  });

  it("reads shell idle at the prompt and stopped once the PTY is gone", () => {
    seed([{ id: "a", label: "main", running: true }]);
    const { rerender } = render(<CompanionSession workspaceId={WS} />);
    expect(screen.getByText("shell idle")).toBeTruthy();

    seed([{ id: "a", label: "main", running: false }]);
    rerender(<CompanionSession workspaceId={WS} />);
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("keeps the restored badge", () => {
    seed([{ id: "a", label: "main", restored: true }]);
    render(<CompanionSession workspaceId={WS} />);
    expect(screen.getByTestId("session-detail-restored")).toBeTruthy();
  });

  it("renames on double-click, committing with Enter", () => {
    seed([{ id: "a", label: "main" }]);
    mockIpc.renameTerminal.mockResolvedValue(undefined);
    render(<CompanionSession workspaceId={WS} />);

    fireEvent.doubleClick(screen.getByTestId("session-detail-label"));
    const input = screen.getByTestId("session-detail-rename");
    fireEvent.change(input, { target: { value: "logs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("a", "logs");
  });

  it("abandons a rename on Escape", () => {
    seed([{ id: "a", label: "main" }]);
    render(<CompanionSession workspaceId={WS} />);

    fireEvent.doubleClick(screen.getByTestId("session-detail-label"));
    const input = screen.getByTestId("session-detail-rename");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-detail-label").textContent).toBe("main");
  });

  it("closes the session", () => {
    seed([{ id: "a", label: "main" }]);
    mockIpc.deleteTerminal.mockResolvedValue(undefined);
    render(<CompanionSession workspaceId={WS} />);

    fireEvent.click(screen.getByTestId("session-detail-close"));
    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("a");
  });

  it("says the room is empty rather than rendering a blank panel", () => {
    seed([]);
    render(<CompanionSession workspaceId={WS} />);
    expect(screen.getByText("No sessions open.")).toBeTruthy();
  });
});

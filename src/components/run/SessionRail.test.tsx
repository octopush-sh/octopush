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
const { SessionRail } = await import("./SessionRail");

const WS = "ws-rail";

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
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  useAttentionStore.setState({ flagsByWs: {} });
  vi.clearAllMocks();
});

describe("SessionRail", () => {
  it("renders one cell per session, marking the active one", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "b");
    render(<SessionRail workspaceId={WS} />);

    expect(screen.getByTestId("session-cell-a")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("session-cell-b")).toHaveAttribute("aria-selected", "true");
  });

  it("names the session and what it is doing in the cell's tooltip", () => {
    seed([{ id: "a", label: "dev", role: "dev", busy: true, command: "npm run dev" }]);
    render(<SessionRail workspaceId={WS} />);

    // Busy sessions report the live command; the jump shortcut rides along.
    expect(screen.getByTestId("session-cell-a")).toHaveAttribute(
      "title",
      "dev — npm run dev (⌘⌥1)",
    );
  });

  it("shows an icon at rest and the jump number while a modifier is held", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }]);
    render(<SessionRail workspaceId={WS} />);

    const cell = screen.getByTestId("session-cell-b");
    expect(cell.querySelector("svg")).toBeTruthy();
    expect(cell.textContent).toBe("");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    });
    expect(screen.getByTestId("session-cell-b").textContent).toBe("2");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    });
    expect(screen.getByTestId("session-cell-b").querySelector("svg")).toBeTruthy();
  });

  it("drops the peek when the window loses focus, so the rail can't stick", () => {
    seed([{ id: "a", label: "main" }]);
    render(<SessionRail workspaceId={WS} />);

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
    render(<SessionRail workspaceId={WS} />);

    expect(screen.queryByTestId("session-busy-a")).toBeNull();
    expect(screen.getByTestId("session-busy-b")).toHaveClass("rail-bar-running");
  });

  it("marks the session that rang — not every session in the workspace", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "b");
    });
    render(<SessionRail workspaceId={WS} />);

    expect(screen.getByTestId("session-bell-b")).toBeTruthy();
    expect(screen.queryByTestId("session-bell-a")).toBeNull();
  });

  it("never marks the session you are already looking at", () => {
    seed([{ id: "a", label: "main" }], "a");
    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "a");
    });
    render(<SessionRail workspaceId={WS} />);

    expect(screen.queryByTestId("session-bell-a")).toBeNull();
  });

  it("switches session on click", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    render(<SessionRail workspaceId={WS} />);

    fireEvent.click(screen.getByTestId("session-cell-b"));
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
  });

  it("opens a session from the rail's own control", () => {
    seed([{ id: "a", label: "main" }]);
    mockIpc.createTerminal.mockResolvedValue({ id: "new", label: "Terminal 2", position: 1 });
    render(<SessionRail workspaceId={WS} />);

    fireEvent.click(screen.getByTestId("session-new"));
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(WS, "Terminal 2");
  });

  it("keeps rename and close reachable in the hover flyout", async () => {
    seed([{ id: "a", label: "main", role: "git" }]);
    mockIpc.renameTerminal.mockResolvedValue(undefined);
    mockIpc.deleteTerminal.mockResolvedValue(undefined);
    render(<SessionRail workspaceId={WS} />);

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
    render(<SessionRail workspaceId={WS} />);

    const first = screen.getByTestId("session-cell-a");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(document.activeElement).toBe(screen.getByTestId("session-cell-b"));
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");

    fireEvent.keyDown(screen.getByTestId("session-cell-b"), { key: "Enter" });
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
  });
});

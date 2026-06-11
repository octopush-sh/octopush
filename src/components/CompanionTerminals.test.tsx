/**
 * Tests for CompanionTerminals.
 *
 * The component reads directly from useTerminalsStore, so we seed the store
 * state before each test and verify that interactions call the right store actions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ─── Mock IPC (the store uses it internally) ──────────────────────

const mockIpc = {
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
  listPtySessions: vi.fn(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

// ─── Import after mocking ─────────────────────────────────────────

const { useTerminalsStore } = await import("../stores/terminalsStore");
const { CompanionTerminals } = await import("./CompanionTerminals");

// ─── Helpers ──────────────────────────────────────────────────────

const WS = "ws-test";

function seedTerminals(
  terminals: Array<{ id: string; label: string; running?: boolean; restored?: boolean }>,
  activeId?: string,
) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: terminals.map((t, i) => ({
        id: t.id,
        label: t.label,
        position: i,
        running: t.running ?? false,
        restored: t.restored ?? false,
      })),
    },
    activeByWs: { [WS]: activeId ?? terminals[0]?.id ?? null },
  });
}

function resetStore() {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  vi.clearAllMocks();
}

// ─── Tests ────────────────────────────────────────────────────────

describe("CompanionTerminals — rendering", () => {
  beforeEach(() => resetStore());

  it("renders one row per terminal in the store", () => {
    seedTerminals([
      { id: "t1", label: "Main" },
      { id: "t2", label: "Server" },
      { id: "t3", label: "Tests" },
    ]);
    render(<CompanionTerminals workspaceId={WS} />);
    expect(screen.getByTestId("label-t1")).toBeInTheDocument();
    expect(screen.getByTestId("label-t2")).toBeInTheDocument();
    expect(screen.getByTestId("label-t3")).toBeInTheDocument();
  });

  it("shows empty message when no terminals exist", () => {
    seedTerminals([]);
    render(<CompanionTerminals workspaceId={WS} />);
    expect(screen.getByText(/no active terminals/i)).toBeInTheDocument();
  });

  it("status dot is brass with a Running title when running", () => {
    seedTerminals([{ id: "t-run", label: "Main", running: true }]);
    render(<CompanionTerminals workspaceId={WS} />);
    const dot = screen.getByTestId("status-dot-t-run");
    expect(dot).toHaveAttribute("title", "Running");
    expect(dot.style.background).toContain("--color-octo-brass");
  });

  it("status dot is muted with a Stopped title when not running", () => {
    seedTerminals([{ id: "t-stop", label: "Main", running: false }]);
    render(<CompanionTerminals workspaceId={WS} />);
    const dot = screen.getByTestId("status-dot-t-stop");
    expect(dot).toHaveAttribute("title", "Stopped");
    expect(dot.style.background).toContain("--color-octo-mute");
  });

  it("does not render a RUNNING/STOPPED meta line", () => {
    seedTerminals([
      { id: "t-r", label: "Main", running: true },
      { id: "t-s", label: "Other", running: false },
    ]);
    render(<CompanionTerminals workspaceId={WS} />);
    expect(screen.queryByText("RUNNING")).not.toBeInTheDocument();
    expect(screen.queryByText("STOPPED")).not.toBeInTheDocument();
  });

  it("delete button is a sibling of the select button, not nested inside it", () => {
    seedTerminals([{ id: "t-nest", label: "Main" }]);
    render(<CompanionTerminals workspaceId={WS} />);
    const deleteBtn = screen.getByTestId("delete-btn-t-nest");
    // No button-in-button nesting: the delete button has no button ancestor.
    expect(deleteBtn.parentElement?.closest("button")).toBeNull();
    // And the select button (holding the label) does not contain it.
    const selectBtn = screen.getByTestId("label-t-nest").closest("button")!;
    expect(selectBtn.contains(deleteBtn)).toBe(false);
  });
});

describe("CompanionTerminals — active switch", () => {
  beforeEach(() => resetStore());

  it("clicking a non-active row calls setActive", () => {
    seedTerminals(
      [
        { id: "t-a", label: "A" },
        { id: "t-b", label: "B" },
      ],
      "t-a",
    );
    render(<CompanionTerminals workspaceId={WS} />);

    // Click the row for "B" — should switch active
    const labelB = screen.getByTestId("label-t-b");
    fireEvent.click(labelB.closest("button")!);

    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("t-b");
  });

  it("clicking the already-active row does not throw", () => {
    seedTerminals([{ id: "t-only", label: "Only" }]);
    render(<CompanionTerminals workspaceId={WS} />);
    expect(() =>
      fireEvent.click(screen.getByTestId("label-t-only").closest("button")!),
    ).not.toThrow();
  });
});

describe("CompanionTerminals — inline rename", () => {
  beforeEach(() => resetStore());

  it("double-clicking label shows an input with current value", async () => {
    seedTerminals([{ id: "t-rename", label: "OldName" }]);
    render(<CompanionTerminals workspaceId={WS} />);

    const label = screen.getByTestId("label-t-rename");
    fireEvent.dblClick(label);

    const input = await screen.findByTestId("rename-input-t-rename");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("OldName");
  });

  it("pressing Enter calls renameTerminal with the new value", async () => {
    mockIpc.renameTerminal.mockResolvedValueOnce(undefined);
    seedTerminals([{ id: "t-enter", label: "Old" }]);
    render(<CompanionTerminals workspaceId={WS} />);

    fireEvent.dblClick(screen.getByTestId("label-t-enter"));
    const input = await screen.findByTestId("rename-input-t-enter");

    // Simulate typing a new name
    fireEvent.change(input, { target: { value: "NewName" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("t-enter", "NewName");
    // Input should disappear
    expect(screen.queryByTestId("rename-input-t-enter")).not.toBeInTheDocument();
  });

  it("pressing Escape closes the input without calling renameTerminal", async () => {
    seedTerminals([{ id: "t-esc", label: "Orig" }]);
    render(<CompanionTerminals workspaceId={WS} />);

    fireEvent.dblClick(screen.getByTestId("label-t-esc"));
    const input = await screen.findByTestId("rename-input-t-esc");

    fireEvent.change(input, { target: { value: "ShouldNotSave" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rename-input-t-esc")).not.toBeInTheDocument();
    // Label should still show the original value
    expect(screen.getByTestId("label-t-esc")).toHaveTextContent("Orig");
  });

  it("blurring the input commits the rename", async () => {
    mockIpc.renameTerminal.mockResolvedValueOnce(undefined);
    seedTerminals([{ id: "t-blur", label: "Before" }]);
    render(<CompanionTerminals workspaceId={WS} />);

    fireEvent.dblClick(screen.getByTestId("label-t-blur"));
    const input = await screen.findByTestId("rename-input-t-blur");

    fireEvent.change(input, { target: { value: "After" } });
    await act(async () => {
      fireEvent.blur(input);
    });

    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("t-blur", "After");
  });

  it("whitespace-only input does not call renameTerminal", async () => {
    seedTerminals([{ id: "t-ws", label: "Keep" }]);
    render(<CompanionTerminals workspaceId={WS} />);

    fireEvent.dblClick(screen.getByTestId("label-t-ws"));
    const input = await screen.findByTestId("rename-input-t-ws");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();
  });
});

describe("CompanionTerminals — create + delete", () => {
  beforeEach(() => resetStore());

  it("clicking + button calls createTerminal", () => {
    const rec = { id: "new-t", workspaceId: WS, label: "Terminal 1", position: 0, createdAt: 0 };
    mockIpc.createTerminal.mockResolvedValueOnce(rec);
    seedTerminals([]);
    render(<CompanionTerminals workspaceId={WS} />);

    fireEvent.click(screen.getByTitle("New terminal"));
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(WS, expect.any(String));
  });

  it("clicking × calls deleteTerminal", () => {
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);
    seedTerminals([
      { id: "t-del", label: "ToDelete" },
      { id: "t-keep", label: "Keep" },
    ]);
    render(<CompanionTerminals workspaceId={WS} />);

    const deleteBtn = screen.getByTestId("delete-btn-t-del");
    fireEvent.click(deleteBtn);

    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("t-del");
  });
});

describe("CompanionTerminals — Restored badge", () => {
  beforeEach(() => resetStore());

  it("shows Restored badge when terminal has restored=true", () => {
    seedTerminals([{ id: "t-restored", label: "Main", running: true, restored: true }]);
    render(<CompanionTerminals workspaceId={WS} />);

    expect(screen.getByTestId("restored-badge-t-restored")).toBeInTheDocument();
    expect(screen.getByTestId("restored-badge-t-restored")).toHaveTextContent("Restored");
  });

  it("does not show Restored badge when restored=false", () => {
    seedTerminals([{ id: "t-normal", label: "Main", running: true, restored: false }]);
    render(<CompanionTerminals workspaceId={WS} />);

    expect(screen.queryByTestId("restored-badge-t-normal")).not.toBeInTheDocument();
  });

  it("removes the badge when the store clears the restored flag", () => {
    // The 5s expiry timer now lives in the store (scheduled by loadTerminals,
    // covered in terminalsStore.test.ts); the component just reflects state.
    seedTerminals([{ id: "t-dismiss", label: "Main", running: true, restored: true }]);
    render(<CompanionTerminals workspaceId={WS} />);

    expect(screen.getByTestId("restored-badge-t-dismiss")).toBeInTheDocument();

    act(() => {
      useTerminalsStore.getState().clearRestored(WS, "t-dismiss");
    });

    expect(screen.queryByTestId("restored-badge-t-dismiss")).not.toBeInTheDocument();
  });
});

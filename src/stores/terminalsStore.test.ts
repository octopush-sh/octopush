/**
 * Tests for terminalsStore.
 *
 * Invariants under test:
 * 1. loadTerminals populates state and sets activeId to the first terminal.
 * 2. createTerminal appends to the end and becomes active.
 * 3. renameTerminal applies an optimistic update that reverts on failure.
 * 4. deleteTerminal from the active position reassigns active to the neighbor.
 * 5. Cross-workspace isolation — two workspaces never share state.
 * 6. Empty selectors return stable references (no infinite re-render trap).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalRecord } from "../lib/types";

// ─── Mocks ────────────────────────────────────────────────────────

let nextId = 0;
function makeRecord(
  workspaceId: string,
  label: string,
  position: number,
): TerminalRecord {
  return {
    id: `term-${++nextId}`,
    workspaceId,
    label,
    position,
    createdAt: Date.now(),
  };
}

import type { PtySession } from "../lib/types";

const mockIpc = {
  listTerminals: vi.fn<(workspaceId: string) => Promise<TerminalRecord[]>>(),
  createTerminal: vi.fn<
    (workspaceId: string, label: string) => Promise<TerminalRecord>
  >(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
  listPtySessions: vi.fn<() => Promise<PtySession[]>>(),
};

vi.mock("../lib/ipc", () => ({
  ipc: mockIpc,
}));

// The store surfaces delete failures via toast; stub the toast API so the
// test doesn't pull the Tauri event layer in.
const mockPushToast = vi.fn();
vi.mock("../components/Toasts", () => ({
  pushToast: (t: unknown) => mockPushToast(t),
}));

const { useTerminalsStore } = await import("./terminalsStore");

// ─── Helpers ──────────────────────────────────────────────────────

function resetStore() {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  nextId = 0;
  vi.clearAllMocks();
  // Default: daemon has no live sessions (cold start).
  mockIpc.listPtySessions.mockResolvedValue([]);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("terminalsStore — loadTerminals", () => {
  beforeEach(() => resetStore());

  it("populates state and sets active to first terminal", async () => {
    const ws = "ws-load";
    mockIpc.listTerminals.mockResolvedValueOnce([
      makeRecord(ws, "Main", 0),
      makeRecord(ws, "Terminal 2", 1),
    ]);
    // Daemon has no live sessions (cold start).
    mockIpc.listPtySessions.mockResolvedValueOnce([]);

    await useTerminalsStore.getState().loadTerminals(ws);

    const terminals = useTerminalsStore.getState().getTerminals(ws);
    expect(terminals).toHaveLength(2);
    expect(terminals[0].label).toBe("Main");
    expect(terminals[1].label).toBe("Terminal 2");
    expect(terminals.every((t) => t.running === false)).toBe(true);
    expect(terminals.every((t) => t.restored === false)).toBe(true);

    const active = useTerminalsStore.getState().getActiveId(ws);
    expect(active).toBe(terminals[0].id);
  });

  it("marks running=true and restored=true when daemon has a live session", async () => {
    const ws = "ws-reattach";
    const rec0 = makeRecord(ws, "Main", 0);
    const rec1 = makeRecord(ws, "Secondary", 1);
    mockIpc.listTerminals.mockResolvedValueOnce([rec0, rec1]);
    // Daemon reports rec0 as alive (e.g. survived Octopush restart).
    mockIpc.listPtySessions.mockResolvedValueOnce([
      { id: rec0.id, running: true, startedAt: Date.now() },
    ]);

    await useTerminalsStore.getState().loadTerminals(ws);

    const terminals = useTerminalsStore.getState().getTerminals(ws);
    expect(terminals).toHaveLength(2);

    const t0 = terminals.find((t) => t.id === rec0.id)!;
    expect(t0.running).toBe(true);
    expect(t0.restored).toBe(true);

    const t1 = terminals.find((t) => t.id === rec1.id)!;
    expect(t1.running).toBe(false);
    expect(t1.restored).toBe(false);
  });

  it("does not overwrite an already-selected active id on reload", async () => {
    const ws = "ws-reload";
    const records = [makeRecord(ws, "Main", 0), makeRecord(ws, "Secondary", 1)];
    mockIpc.listTerminals.mockResolvedValueOnce(records);
    mockIpc.listPtySessions.mockResolvedValueOnce([]);
    await useTerminalsStore.getState().loadTerminals(ws);

    // User switched to second terminal
    useTerminalsStore.getState().setActive(ws, records[1].id);

    // Reload (e.g., workspace re-focus)
    mockIpc.listTerminals.mockResolvedValueOnce(records);
    mockIpc.listPtySessions.mockResolvedValueOnce([]);
    await useTerminalsStore.getState().loadTerminals(ws);

    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(records[1].id);
  });

  it("sets active to null when workspace has no terminals", async () => {
    const ws = "ws-empty";
    mockIpc.listTerminals.mockResolvedValueOnce([]);
    mockIpc.listPtySessions.mockResolvedValueOnce([]);

    await useTerminalsStore.getState().loadTerminals(ws);

    expect(useTerminalsStore.getState().getTerminals(ws)).toHaveLength(0);
    expect(useTerminalsStore.getState().getActiveId(ws)).toBeNull();
  });
});

describe("terminalsStore — createTerminal", () => {
  beforeEach(() => resetStore());

  it("first terminal gets label Main", async () => {
    const ws = "ws-create-first";
    const rec = makeRecord(ws, "Main", 0);
    mockIpc.createTerminal.mockResolvedValueOnce(rec);

    const t = await useTerminalsStore.getState().createTerminal(ws);
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(ws, "Main");
    expect(t.label).toBe("Main");
  });

  it("subsequent terminals get numbered label", async () => {
    const ws = "ws-create-nth";
    // Pre-populate with one terminal
    const existing = makeRecord(ws, "Main", 0);
    useTerminalsStore.setState({
      terminalsByWs: {
        [ws]: [{ id: existing.id, label: existing.label, position: 0, running: false, restored: false }],
      },
      activeByWs: { [ws]: existing.id },
    });

    const rec2 = makeRecord(ws, "Terminal 2", 1);
    mockIpc.createTerminal.mockResolvedValueOnce(rec2);

    await useTerminalsStore.getState().createTerminal(ws);
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(ws, "Terminal 2");
  });

  it("appends to the end and sets as active", async () => {
    const ws = "ws-create-append";
    const rec = makeRecord(ws, "Main", 0);
    mockIpc.createTerminal.mockResolvedValueOnce(rec);

    const t = await useTerminalsStore.getState().createTerminal(ws);

    const terminals = useTerminalsStore.getState().getTerminals(ws);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe(t.id);
    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(t.id);
  });

  it("respects explicit label override", async () => {
    const ws = "ws-create-label";
    const rec = makeRecord(ws, "Build", 0);
    mockIpc.createTerminal.mockResolvedValueOnce(rec);

    await useTerminalsStore.getState().createTerminal(ws, "Build");
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(ws, "Build");
  });
});

describe("terminalsStore — renameTerminal", () => {
  beforeEach(() => resetStore());

  it("applies optimistic update immediately", async () => {
    const ws = "ws-rename";
    let resolveRename!: () => void;
    mockIpc.renameTerminal.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveRename = res;
      }),
    );

    const rec = makeRecord(ws, "Old", 0);
    useTerminalsStore.setState({
      terminalsByWs: {
        [ws]: [{ id: rec.id, label: "Old", position: 0, running: false, restored: false }],
      },
      activeByWs: { [ws]: rec.id },
    });

    const promise = useTerminalsStore.getState().renameTerminal(ws, rec.id, "New");

    // Optimistic: label should already be updated before IPC resolves
    expect(useTerminalsStore.getState().getTerminals(ws)[0].label).toBe("New");

    resolveRename();
    await promise;
    expect(useTerminalsStore.getState().getTerminals(ws)[0].label).toBe("New");
  });

  it("reverts on IPC failure", async () => {
    const ws = "ws-rename-revert";
    mockIpc.renameTerminal.mockRejectedValueOnce(new Error("network error"));

    const rec = makeRecord(ws, "Original", 0);
    useTerminalsStore.setState({
      terminalsByWs: {
        [ws]: [{ id: rec.id, label: "Original", position: 0, running: false, restored: false }],
      },
      activeByWs: { [ws]: rec.id },
    });

    await expect(
      useTerminalsStore.getState().renameTerminal(ws, rec.id, "Changed"),
    ).rejects.toThrow("network error");

    // Should have reverted back to "Original"
    expect(useTerminalsStore.getState().getTerminals(ws)[0].label).toBe("Original");
  });
});

describe("terminalsStore — deleteTerminal", () => {
  beforeEach(() => resetStore());

  it("removes terminal from list", async () => {
    const ws = "ws-delete";
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);

    const rec = makeRecord(ws, "Main", 0);
    useTerminalsStore.setState({
      terminalsByWs: {
        [ws]: [{ id: rec.id, label: "Main", position: 0, running: false, restored: false }],
      },
      activeByWs: { [ws]: rec.id },
    });

    await useTerminalsStore.getState().deleteTerminal(ws, rec.id);

    expect(useTerminalsStore.getState().getTerminals(ws)).toHaveLength(0);
    expect(useTerminalsStore.getState().getActiveId(ws)).toBeNull();
  });

  it("deleting active terminal selects the next neighbor", async () => {
    const ws = "ws-delete-active";
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);

    const a = { id: "t-a", label: "A", position: 0, running: false, restored: false };
    const b = { id: "t-b", label: "B", position: 1, running: false, restored: false };
    const c = { id: "t-c", label: "C", position: 2, running: false, restored: false };

    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [a, b, c] },
      activeByWs: { [ws]: b.id }, // active is B (index 1)
    });

    await useTerminalsStore.getState().deleteTerminal(ws, b.id);

    const remaining = useTerminalsStore.getState().getTerminals(ws);
    expect(remaining).toHaveLength(2);
    // Next neighbor (index 1 after removal) is C
    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(c.id);
  });

  it("deleting active last terminal falls back to the previous one", async () => {
    const ws = "ws-delete-last";
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);

    const a = { id: "t-a2", label: "A", position: 0, running: false, restored: false };
    const b = { id: "t-b2", label: "B", position: 1, running: false, restored: false };

    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [a, b] },
      activeByWs: { [ws]: b.id }, // active is the last one
    });

    await useTerminalsStore.getState().deleteTerminal(ws, b.id);

    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(a.id);
  });

  it("deleting non-active terminal preserves active", async () => {
    const ws = "ws-delete-nonactive";
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);

    const a = { id: "t-na-a", label: "A", position: 0, running: false, restored: false };
    const b = { id: "t-na-b", label: "B", position: 1, running: false, restored: false };

    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [a, b] },
      activeByWs: { [ws]: a.id }, // A is active, deleting B
    });

    await useTerminalsStore.getState().deleteTerminal(ws, b.id);

    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(a.id);
  });

  it("IPC failure leaves the terminal in the store and surfaces a toast", async () => {
    const ws = "ws-delete-fail";
    mockIpc.deleteTerminal.mockRejectedValueOnce(new Error("daemon unreachable"));

    const t = { id: "t-fail", label: "Main", position: 0, running: true, restored: false };
    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [t] },
      activeByWs: { [ws]: t.id },
    });

    await useTerminalsStore.getState().deleteTerminal(ws, t.id);

    // State untouched: the terminal is still there and still active.
    expect(useTerminalsStore.getState().getTerminals(ws)).toHaveLength(1);
    expect(useTerminalsStore.getState().getTerminals(ws)[0].id).toBe(t.id);
    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(t.id);

    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Couldn't close terminal" }),
    );
  });
});

describe("terminalsStore — load/mutation races", () => {
  beforeEach(() => resetStore());

  it("discards a stale loadTerminals result after an interleaved delete", async () => {
    const ws = "ws-stale-load";
    const a = { id: "t-stale-a", label: "A", position: 0, running: false, restored: false };
    const b = { id: "t-stale-b", label: "B", position: 1, running: false, restored: false };
    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [a, b] },
      activeByWs: { [ws]: a.id },
    });

    // loadTerminals starts, but its DB fetch hangs on a deferred promise.
    let resolveList!: (records: TerminalRecord[]) => void;
    mockIpc.listTerminals.mockReturnValueOnce(
      new Promise<TerminalRecord[]>((res) => {
        resolveList = res;
      }),
    );
    mockIpc.listPtySessions.mockResolvedValueOnce([]);
    const loadPromise = useTerminalsStore.getState().loadTerminals(ws);

    // While the fetch is in flight, the user deletes B.
    mockIpc.deleteTerminal.mockResolvedValueOnce(undefined);
    await useTerminalsStore.getState().deleteTerminal(ws, b.id);
    expect(useTerminalsStore.getState().getTerminals(ws)).toHaveLength(1);

    // The fetch finally resolves with the pre-delete snapshot (A and B).
    resolveList([
      { id: a.id, workspaceId: ws, label: "A", position: 0, createdAt: 0 },
      { id: b.id, workspaceId: ws, label: "B", position: 1, createdAt: 0 },
    ]);
    await loadPromise;

    // Stale snapshot discarded — B stays deleted.
    const terminals = useTerminalsStore.getState().getTerminals(ws);
    expect(terminals.map((t) => t.id)).toEqual([a.id]);
  });

  it("falls back to the first terminal when the preserved active id vanishes", async () => {
    const ws = "ws-active-fallback";
    // Active points at a terminal that the fresh DB list no longer contains.
    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [] },
      activeByWs: { [ws]: "t-ghost" },
    });

    const rec = makeRecord(ws, "Main", 0);
    mockIpc.listTerminals.mockResolvedValueOnce([rec]);
    mockIpc.listPtySessions.mockResolvedValueOnce([]);

    await useTerminalsStore.getState().loadTerminals(ws);

    expect(useTerminalsStore.getState().getActiveId(ws)).toBe(rec.id);
  });
});

describe("terminalsStore — restored badge expiry", () => {
  beforeEach(() => resetStore());

  it("clears the restored flag 5 seconds after a reattach-load", async () => {
    vi.useFakeTimers();
    try {
      const ws = "ws-restored-expiry";
      const rec = makeRecord(ws, "Main", 0);
      mockIpc.listTerminals.mockResolvedValueOnce([rec]);
      // Daemon reports the session alive — a restore.
      mockIpc.listPtySessions.mockResolvedValueOnce([
        { id: rec.id, running: true, startedAt: Date.now() },
      ]);

      await useTerminalsStore.getState().loadTerminals(ws);
      expect(useTerminalsStore.getState().getTerminals(ws)[0].restored).toBe(true);

      vi.advanceTimersByTime(5001);

      const t = useTerminalsStore.getState().getTerminals(ws)[0];
      expect(t.restored).toBe(false);
      expect(t.running).toBe(true); // only the badge expires, not the state
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminalsStore — markRunning", () => {
  beforeEach(() => resetStore());

  it("sets running true/false on the targeted terminal", () => {
    const ws = "ws-running";
    const t = { id: "t-run", label: "Main", position: 0, running: false, restored: false };

    useTerminalsStore.setState({
      terminalsByWs: { [ws]: [t] },
      activeByWs: { [ws]: t.id },
    });

    useTerminalsStore.getState().markRunning(ws, t.id, true);
    expect(useTerminalsStore.getState().getTerminals(ws)[0].running).toBe(true);

    useTerminalsStore.getState().markRunning(ws, t.id, false);
    expect(useTerminalsStore.getState().getTerminals(ws)[0].running).toBe(false);
  });
});

describe("terminalsStore — workspace isolation", () => {
  beforeEach(() => resetStore());

  it("two workspaces have independent terminal lists", async () => {
    const wsA = "ws-iso-a";
    const wsB = "ws-iso-b";

    const recA = makeRecord(wsA, "Main-A", 0);
    const recB = makeRecord(wsB, "Main-B", 0);
    mockIpc.listTerminals
      .mockResolvedValueOnce([recA])
      .mockResolvedValueOnce([recB]);
    mockIpc.listPtySessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await useTerminalsStore.getState().loadTerminals(wsA);
    await useTerminalsStore.getState().loadTerminals(wsB);

    expect(useTerminalsStore.getState().getTerminals(wsA)).toHaveLength(1);
    expect(useTerminalsStore.getState().getTerminals(wsA)[0].label).toBe("Main-A");
    expect(useTerminalsStore.getState().getTerminals(wsB)).toHaveLength(1);
    expect(useTerminalsStore.getState().getTerminals(wsB)[0].label).toBe("Main-B");

    expect(useTerminalsStore.getState().getActiveId(wsA)).toBe(recA.id);
    expect(useTerminalsStore.getState().getActiveId(wsB)).toBe(recB.id);
  });

  it("renaming in ws-A does not affect ws-B", async () => {
    const wsA = "ws-iso-rename-a";
    const wsB = "ws-iso-rename-b";

    const tA = { id: "ti-a", label: "A", position: 0, running: false, restored: false };
    const tB = { id: "ti-b", label: "B", position: 0, running: false, restored: false };

    useTerminalsStore.setState({
      terminalsByWs: { [wsA]: [tA], [wsB]: [tB] },
      activeByWs: { [wsA]: tA.id, [wsB]: tB.id },
    });

    mockIpc.renameTerminal.mockResolvedValueOnce(undefined);
    await useTerminalsStore.getState().renameTerminal(wsA, tA.id, "Renamed");

    expect(useTerminalsStore.getState().getTerminals(wsA)[0].label).toBe("Renamed");
    expect(useTerminalsStore.getState().getTerminals(wsB)[0].label).toBe("B");
  });

  it("empty selectors return stable references", () => {
    const ws = "ws-iso-never-seen";
    const t1 = useTerminalsStore.getState().getTerminals(ws);
    const t2 = useTerminalsStore.getState().getTerminals(ws);
    expect(t1).toBe(t2);

    expect(useTerminalsStore.getState().getActiveId(ws)).toBeNull();
  });
});

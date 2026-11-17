import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({ ipc: { workspaceDiffSize: vi.fn() } }));

const { ipc } = await import("../lib/ipc");
const { useDiffSizeStore, diffSizeKey, diffSizeLabel, diffSizeTitle, orderSettled } = await import("./diffSizeStore");

beforeEach(() => {
  useDiffSizeStore.setState({ byKey: {} });
  vi.clearAllMocks();
});

describe("diffSizeStore", () => {
  it("measures a run state once, again only when the state changes", async () => {
    vi.mocked(ipc.workspaceDiffSize).mockResolvedValue({ files: 2, added: 5, removed: 1, base: "main" });
    const { ensure } = useDiffSizeStore.getState();
    ensure("r1", "paused", "ws");
    ensure("r1", "paused", "ws"); // in flight: no second call
    await vi.waitFor(() => expect(useDiffSizeStore.getState().byKey[diffSizeKey("r1", "paused")]).toBeTruthy());
    ensure("r1", "paused", "ws");
    await Promise.resolve();
    expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(1);
    ensure("r1", "completed", "ws");
    await vi.waitFor(() => expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(2));
  });

  it("stores null — nothing to show — when the command fails or finds no worktree", async () => {
    vi.mocked(ipc.workspaceDiffSize).mockRejectedValueOnce(new Error("boom"));
    useDiffSizeStore.getState().ensure("r2", "completed", "ws");
    await vi.waitFor(() => expect(diffSizeKey("r2", "completed") in useDiffSizeStore.getState().byKey).toBe(true));
    expect(useDiffSizeStore.getState().byKey[diffSizeKey("r2", "completed")]).toBeNull();
  });

  it("labels the size and says what it was measured against", () => {
    expect(diffSizeLabel({ files: 6, added: 120, removed: 40, base: "main" })).toBe("+120 −40 · 6 files");
    expect(diffSizeLabel({ files: 1, added: 2000, removed: 0, base: "main" })).toBe("+2000 −0 · 1 file");
    expect(diffSizeLabel({ files: 0, added: 0, removed: 0, base: "main" })).toBe("no changes");
    expect(diffSizeTitle({ files: 0, added: 0, removed: 0, base: null })).toBe("Uncommitted changes (no base branch): no changes");
  });

  it("orders smallest first with unmeasured runs last, keeping the oldest-first order among ties", () => {
    const runs = [
      { id: "a", status: "completed" },
      { id: "b", status: "completed" },
      { id: "c", status: "completed" },
      { id: "d", status: "failed" },
    ];
    const byKey = {
      [diffSizeKey("a", "completed")]: { files: 9, added: 900, removed: 0, base: "main" },
      [diffSizeKey("b", "completed")]: null,
      [diffSizeKey("c", "completed")]: { files: 1, added: 3, removed: 1, base: "main" },
      [diffSizeKey("d", "failed")]: { files: 1, added: 3, removed: 1, base: "main" },
    };
    expect(orderSettled(runs, "oldest", byKey).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(orderSettled(runs, "smallest", byKey).map((r) => r.id)).toEqual(["c", "d", "a", "b"]);
  });
});

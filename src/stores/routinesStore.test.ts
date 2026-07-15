import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ipc + toast layer so the store runs without Tauri.
const runRoutineNow = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listRoutines: vi.fn().mockResolvedValue([]),
    runRoutineNow: (...a: unknown[]) => runRoutineNow(...a),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: vi.fn() }));

const { useRoutinesStore } = await import("./routinesStore");

describe("routinesStore — run-now pending state", () => {
  beforeEach(() => {
    runRoutineNow.mockReset();
    useRoutinesStore.setState({ routines: [], runningNow: [] });
  });

  it("marks a routine pending while its fire is in flight, and clears it after", async () => {
    let resolve!: (v: { outcome: string }) => void;
    runRoutineNow.mockReturnValue(new Promise((r) => { resolve = r; }));

    const p = useRoutinesStore.getState().runNow("r1");
    // In flight ⇒ the Run-now button is disabled off this list.
    expect(useRoutinesStore.getState().runningNow).toContain("r1");

    resolve({ outcome: "dispatched" });
    await p;
    expect(useRoutinesStore.getState().runningNow).not.toContain("r1");
  });

  it("ignores a re-click for the same routine while it is still running", async () => {
    let resolve!: (v: { outcome: string }) => void;
    runRoutineNow.mockReturnValue(new Promise((r) => { resolve = r; }));

    const first = useRoutinesStore.getState().runNow("r1");
    // A second click while pending is a no-op — no duplicate concurrent fire.
    await useRoutinesStore.getState().runNow("r1");
    expect(runRoutineNow).toHaveBeenCalledTimes(1);

    resolve({ outcome: "dispatched" });
    await first;
  });

  it("clears the pending flag even when the fire rejects", async () => {
    runRoutineNow.mockRejectedValue(new Error("boom"));
    await useRoutinesStore.getState().runNow("r1");
    expect(useRoutinesStore.getState().runningNow).not.toContain("r1");
  });
});

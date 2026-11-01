import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoutinePhaseEvent } from "../lib/ipc";

// Mock the ipc + toast layer so the store runs without Tauri.
const runRoutineNow = vi.fn();
let phaseHandler: ((ev: RoutinePhaseEvent) => void) | null = null;
const unlistenPhase = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listRoutines: vi.fn().mockResolvedValue([]),
    runRoutineNow: (...a: unknown[]) => runRoutineNow(...a),
    onRoutinePhase: (handler: (ev: RoutinePhaseEvent) => void) => {
      phaseHandler = handler;
      return Promise.resolve(() => {
        phaseHandler = null;
        unlistenPhase();
      });
    },
  },
}));
const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

const { useRoutinesStore, describeRoutinePhase } = await import("./routinesStore");

describe("routinesStore — run-now pending state", () => {
  beforeEach(() => {
    runRoutineNow.mockReset();
    pushToast.mockReset();
    unlistenPhase.mockReset();
    useRoutinesStore.setState({ routines: [], runningNow: [], phaseById: {} });
  });

  it("marks a routine pending while its fire is in flight, and clears it after", async () => {
    let resolve!: (v: { outcome: string }) => void;
    runRoutineNow.mockReturnValue(new Promise((r) => { resolve = r; }));

    const p = useRoutinesStore.getState().runNow("r1");
    // In flight ⇒ the Run-now button is disabled off this list.
    expect(useRoutinesStore.getState().runningNow).toContain("r1");

    await vi.waitFor(() => expect(runRoutineNow).toHaveBeenCalled());
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
    await vi.waitFor(() => expect(runRoutineNow).toHaveBeenCalled());
    expect(runRoutineNow).toHaveBeenCalledTimes(1);

    resolve({ outcome: "dispatched" });
    await first;
  });

  it("clears the pending flag even when the fire rejects", async () => {
    runRoutineNow.mockRejectedValue(new Error("boom"));
    await useRoutinesStore.getState().runNow("r1");
    expect(useRoutinesStore.getState().runningNow).not.toContain("r1");
  });

  it("follows the fire's phases while it runs, then forgets them", async () => {
    let resolve!: (v: { outcome: string }) => void;
    runRoutineNow.mockReturnValue(new Promise((r) => { resolve = r; }));

    const p = useRoutinesStore.getState().runNow("r1");
    await vi.waitFor(() => expect(runRoutineNow).toHaveBeenCalled());
    phaseHandler?.({ routineId: "r1", phase: "setup" });
    // Another routine's fire is not this row's progress.
    phaseHandler?.({ routineId: "r2", phase: "condition" });
    expect(useRoutinesStore.getState().phaseById).toEqual({ r1: "setup" });
    expect(describeRoutinePhase("setup")).toBe("running the setup script…");

    resolve({ outcome: "dispatched" });
    await p;
    expect(useRoutinesStore.getState().phaseById).toEqual({});
    expect(unlistenPhase).toHaveBeenCalledTimes(1);
  });

  it("gives a failed setup its own error toast", async () => {
    runRoutineNow.mockResolvedValue({ outcome: "skipped", skip: "setup_failed", reason: "setup failed: exit 1" });
    await useRoutinesStore.getState().runNow("r1");
    expect(pushToast).toHaveBeenCalledTimes(1);
    const toast = pushToast.mock.calls[0][0] as { level: string; title: string; body: string };
    expect(toast.level).toBe("error");
    expect(toast.title).toBe("Setup failed");
    expect(toast.body).not.toContain("window was skipped");
    expect(toast.body).toContain("exit 1");
  });

  it("keeps the skip toast for an empty window", async () => {
    runRoutineNow.mockResolvedValue({ outcome: "skipped", skip: "condition_not_met", reason: "condition not met" });
    await useRoutinesStore.getState().runNow("r1");
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to run" }));
  });
});

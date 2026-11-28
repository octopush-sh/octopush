/**
 * The agent's background processes (#1160) reach the live process panel:
 * listed when a conversation is shown, kept current by the backend's event,
 * and stopped from their row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BackgroundProcess } from "../lib/ipc";

type EventHandler = (ev: { payload: unknown }) => void;
const handlers: Record<string, EventHandler> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    handlers[eventName] = handler;
    return Promise.resolve(() => {});
  }),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    listBackgroundProcesses: vi.fn(),
    stopBackgroundProcess: vi.fn(),
  },
}));

const { useBackgroundProcessStore, listedProcesses, processStatus, selectBackgroundProcesses, BACKGROUND_PROCESSES_EVENT } =
  await import("./backgroundProcessStore");
const { ipc } = await import("../lib/ipc");

function proc(over: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    id: "proc-1",
    kind: "background",
    command: "npm run dev",
    cwd: "/ws",
    startedAt: 1,
    running: true,
    exitCode: null,
    stopped: false,
    lost: false,
    ...over,
  };
}

beforeEach(() => {
  useBackgroundProcessStore.setState({ byThread: {}, stopping: {} });
  vi.mocked(ipc.listBackgroundProcesses).mockReset();
  vi.mocked(ipc.stopBackgroundProcess).mockReset();
});

describe("backgroundProcessStore", () => {
  it("loads a conversation's processes and follows the backend's event", async () => {
    vi.mocked(ipc.listBackgroundProcesses).mockResolvedValue([proc()]);
    await useBackgroundProcessStore.getState().load("t-1");
    expect(ipc.listBackgroundProcesses).toHaveBeenCalledWith("t-1");
    expect(selectBackgroundProcesses("t-1")(useBackgroundProcessStore.getState())).toEqual([proc()]);

    handlers[BACKGROUND_PROCESSES_EVENT]({
      payload: { workspaceId: "w", threadId: "t-1", processes: [proc({ running: false, stopped: true })] },
    });
    expect(useBackgroundProcessStore.getState().byThread["t-1"][0].stopped).toBe(true);
    // Another conversation's list is its own.
    expect(selectBackgroundProcesses("t-2")(useBackgroundProcessStore.getState())).toEqual([]);
    expect(selectBackgroundProcesses(undefined)(useBackgroundProcessStore.getState())).toEqual([]);
  });

  it("a load that fails leaves the list as it was", async () => {
    vi.mocked(ipc.listBackgroundProcesses).mockRejectedValue(new Error("no daemon"));
    await useBackgroundProcessStore.getState().load("t-1");
    expect(useBackgroundProcessStore.getState().byThread["t-1"]).toBeUndefined();
  });

  it("stops a process once, however often its Stop is pressed", async () => {
    let finish: (v: BackgroundProcess) => void = () => {};
    vi.mocked(ipc.stopBackgroundProcess).mockReturnValue(new Promise((r) => (finish = r)));
    const first = useBackgroundProcessStore.getState().stop("t-1", "proc-1");
    expect(useBackgroundProcessStore.getState().stopping["t-1/proc-1"]).toBe(true);
    await useBackgroundProcessStore.getState().stop("t-1", "proc-1");
    expect(ipc.stopBackgroundProcess).toHaveBeenCalledTimes(1);
    finish(proc({ running: false, stopped: true }));
    await first;
    expect(useBackgroundProcessStore.getState().stopping["t-1/proc-1"]).toBeUndefined();
  });

  it("the panel lists running processes, and a promoted one only when its terminal isn't streaming it", () => {
    const all = [
      proc(),
      proc({ id: "proc-2", kind: "promoted" }),
      proc({ id: "proc-3", running: false, exitCode: 0 }),
    ];
    expect(listedProcesses(all, true).map((p) => p.id)).toEqual(["proc-1"]);
    expect(listedProcesses(all, false).map((p) => p.id)).toEqual(["proc-1", "proc-2"]);
    expect(processStatus(proc())).toBe("running");
    expect(processStatus(proc({ running: false, stopped: true }))).toBe("stopped");
    expect(processStatus(proc({ running: false, lost: true }))).toBe("lost");
    expect(processStatus(proc({ running: false, exitCode: 2 }))).toBe("exit 2");
  });
});

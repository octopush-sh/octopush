/** `ipc.onMcpChanged` subscribes to every MCP event, and never leaves one
 *  subscription behind when another fails. */
import { describe, it, expect, vi, afterEach } from "vitest";
// The inert `listen` mock from `src/test-setup.ts`, which `ipc` is bound to.
import { listen as listenFn } from "@tauri-apps/api/event";
import { ipc } from "./ipc";

const listen = vi.mocked(listenFn) as unknown as ReturnType<typeof vi.fn>;
const inert = listen.getMockImplementation();
afterEach(() => {
  listen.mockReset();
  if (inert) listen.mockImplementation(inert);
});

describe("ipc.onMcpChanged", () => {
  it("listens to the three events and unsubscribes them all", async () => {
    const offs = [vi.fn(), vi.fn(), vi.fn()];
    listen.mockReset().mockResolvedValueOnce(offs[0]).mockResolvedValueOnce(offs[1]).mockResolvedValueOnce(offs[2]);
    const handler = vi.fn();
    const off = await ipc.onMcpChanged(handler);
    expect(listen.mock.calls.map((c) => c[0])).toEqual(["mcp://config-changed", "mcp://status-changed", "mcp://trust-changed"]);
    listen.mock.calls[1][1]({ payload: null });
    listen.mock.calls[2][1]({ payload: null });
    expect(handler).toHaveBeenCalledTimes(2);
    off();
    for (const o of offs) expect(o).toHaveBeenCalledTimes(1);
  });

  it("drops the subscriptions that worked when another fails", async () => {
    const off = vi.fn();
    const third = vi.fn();
    listen.mockReset().mockResolvedValueOnce(off).mockRejectedValueOnce(new Error("no window")).mockResolvedValueOnce(third);
    await expect(ipc.onMcpChanged(() => {})).rejects.toThrow("no window");
    expect(off).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });
});

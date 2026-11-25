/** `ipc.onMcpChanged` subscribes to both MCP events, and never leaves one
 *  subscription behind when the other fails. */
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
  it("listens to both events and unsubscribes both", async () => {
    const offs = [vi.fn(), vi.fn()];
    listen.mockReset().mockResolvedValueOnce(offs[0]).mockResolvedValueOnce(offs[1]);
    const handler = vi.fn();
    const off = await ipc.onMcpChanged(handler);
    expect(listen.mock.calls.map((c) => c[0])).toEqual(["mcp://config-changed", "mcp://status-changed"]);
    listen.mock.calls[1][1]({ payload: null });
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    expect(offs[0]).toHaveBeenCalledTimes(1);
    expect(offs[1]).toHaveBeenCalledTimes(1);
  });

  it("drops the subscription that worked when the other fails", async () => {
    const off = vi.fn();
    listen.mockReset().mockResolvedValueOnce(off).mockRejectedValueOnce(new Error("no window"));
    await expect(ipc.onMcpChanged(() => {})).rejects.toThrow("no window");
    expect(off).toHaveBeenCalledTimes(1);
  });
});

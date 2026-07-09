import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authRefresh = vi.fn();
const authSyncPlan = vi.fn();
const getEntitlement = vi.fn();
const pushToast = vi.fn();
const load = vi.fn();

vi.mock("./ipc", () => ({
  ipc: {
    authRefresh: () => authRefresh(),
    authSyncPlan: () => authSyncPlan(),
    getEntitlement: () => getEntitlement(),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));
vi.mock("../stores/entitlementStore", () => ({
  useEntitlementStore: { getState: () => ({ load }) },
}));

// Fresh module per test so the module-level single-flight state can't leak.
async function freshAwaitPro() {
  vi.resetModules();
  return (await import("./awaitPro")).awaitProAfterCheckout;
}

// Drain the microtask queue (the focus path chains authSyncPlan → load → toast).
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("awaitProAfterCheckout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authRefresh.mockReset().mockResolvedValue(undefined);
    authSyncPlan.mockReset().mockResolvedValue(null);
    getEntitlement.mockReset().mockResolvedValue({ plan: "free" });
    pushToast.mockReset();
    load.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects Pro via the poll, reloads entitlement + toasts once", async () => {
    getEntitlement.mockResolvedValue({ plan: "pro" });
    const awaitPro = await freshAwaitPro();
    awaitPro();
    await vi.advanceTimersByTimeAsync(4100);
    expect(load).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatchObject({ level: "success" });
  });

  it("is single-flighted: a second call while active adds no extra focus listener", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const awaitPro = await freshAwaitPro();
    awaitPro();
    awaitPro(); // no-op while the first watch is active
    const focusAdds = addSpy.mock.calls.filter(([ev]) => ev === "focus").length;
    expect(focusAdds).toBe(1);
    addSpy.mockRestore();
    // Drive the watch to completion so its focus listener is removed (the window
    // is shared across tests — an abandoned watch would leak onto the next test).
    getEntitlement.mockResolvedValue({ plan: "pro" });
    await vi.advanceTimersByTimeAsync(4100);
  });

  it("forced refresh on focus flips to Pro at most once", async () => {
    authSyncPlan.mockResolvedValue("pro");
    const awaitPro = await freshAwaitPro();
    awaitPro();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(authSyncPlan).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(1);
    // a repeated focus must NOT trigger another forced token refresh
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(authSyncPlan).toHaveBeenCalledTimes(1);
  });

  it("stays Free quietly when no upgrade lands (no toast)", async () => {
    const awaitPro = await freshAwaitPro();
    awaitPro();
    await vi.advanceTimersByTimeAsync(4100);
    expect(pushToast).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    // Drain the rest of the bounded poll so the watch ends (no leaked listener).
    await vi.advanceTimersByTimeAsync(30 * 4000);
  });
});

/**
 * Unit tests for entitlementStore (premium scaffolding — P0).
 *
 * 1. load() fetches entitlement + usage and marks loaded
 * 2. hasFeature derives from the loaded entitlement
 * 3. load() degrades to Free (loaded, no throw) when IPC fails
 * 4. an `entitlement-changed` event from Rust reloads the store (subscribed once)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Entitlement, DirectRunUsage } from "../lib/ipc";

// ─── Mocks ────────────────────────────────────────────────────────────

const getEntitlementMock = vi.fn<() => Promise<Entitlement>>();
const directRunUsageMock = vi.fn<() => Promise<DirectRunUsage>>();
let changedHandler: (() => void) | null = null;
const onEntitlementChangedMock = vi.fn((h: () => void) => {
  changedHandler = h;
  return Promise.resolve(() => {});
});

vi.mock("../lib/ipc", () => ({
  ipc: {
    getEntitlement: getEntitlementMock,
    directRunUsage: directRunUsageMock,
    onEntitlementChanged: onEntitlementChangedMock,
  },
}));

const { useEntitlementStore, __resetEntitlementWatchForTests } = await import("./entitlementStore");

beforeEach(() => {
  useEntitlementStore.setState({
    entitlement: { plan: "free", features: [], directRunsPerMonth: null },
    usage: null,
    loaded: false,
  });
  getEntitlementMock.mockReset();
  directRunUsageMock.mockReset();
  onEntitlementChangedMock.mockClear();
  changedHandler = null;
  __resetEntitlementWatchForTests();
});

describe("entitlementStore", () => {
  it("loads entitlement + usage and derives hasFeature", async () => {
    getEntitlementMock.mockResolvedValue({
      plan: "free",
      features: ["direct.unlimited", "runs.parallel"],
      directRunsPerMonth: null,
    });
    directRunUsageMock.mockResolvedValue({ used: 3, limit: null, remaining: null });

    await useEntitlementStore.getState().load();

    const s = useEntitlementStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.usage).toEqual({ used: 3, limit: null, remaining: null });
    expect(s.hasFeature("direct.unlimited")).toBe(true);
    expect(s.hasFeature("history.sync")).toBe(false);
  });

  it("reflects a restricted (capped) entitlement", async () => {
    getEntitlementMock.mockResolvedValue({
      plan: "free",
      features: [],
      directRunsPerMonth: 25,
    });
    directRunUsageMock.mockResolvedValue({ used: 25, limit: 25, remaining: 0 });

    await useEntitlementStore.getState().load();

    const s = useEntitlementStore.getState();
    expect(s.entitlement.directRunsPerMonth).toBe(25);
    expect(s.usage?.remaining).toBe(0);
    expect(s.hasFeature("direct.unlimited")).toBe(false);
  });

  it("degrades to Free when IPC fails", async () => {
    getEntitlementMock.mockRejectedValue(new Error("offline"));
    directRunUsageMock.mockRejectedValue(new Error("offline"));

    await useEntitlementStore.getState().load();

    const s = useEntitlementStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.entitlement.plan).toBe("free");
    expect(s.usage).toBeNull();
  });

  it("reloads when Rust emits entitlement-changed, subscribing only once", async () => {
    getEntitlementMock.mockResolvedValue({ plan: "free", features: [], directRunsPerMonth: 25 });
    directRunUsageMock.mockResolvedValue({ used: 1, limit: 25, remaining: 24 });
    await useEntitlementStore.getState().load();
    await useEntitlementStore.getState().load();
    expect(onEntitlementChangedMock).toHaveBeenCalledTimes(1);
    expect(useEntitlementStore.getState().entitlement.plan).toBe("free");

    // A background token refresh flipped the plan to Pro.
    getEntitlementMock.mockResolvedValue({
      plan: "pro",
      features: ["direct.unlimited"],
      directRunsPerMonth: null,
    });
    directRunUsageMock.mockResolvedValue({ used: 1, limit: null, remaining: null });
    expect(changedHandler).not.toBeNull();
    changedHandler!();
    await vi.waitFor(() => expect(useEntitlementStore.getState().entitlement.plan).toBe("pro"));
    expect(useEntitlementStore.getState().hasFeature("direct.unlimited")).toBe(true);
    expect(onEntitlementChangedMock).toHaveBeenCalledTimes(1);
  });

  it("retries the subscription on the next load when listening fails", async () => {
    getEntitlementMock.mockResolvedValue({ plan: "free", features: [], directRunsPerMonth: 25 });
    directRunUsageMock.mockResolvedValue({ used: 0, limit: 25, remaining: 25 });
    onEntitlementChangedMock.mockImplementationOnce(() => Promise.reject(new Error("no tauri")));
    await useEntitlementStore.getState().load();
    await Promise.resolve();
    await useEntitlementStore.getState().load();
    expect(onEntitlementChangedMock).toHaveBeenCalledTimes(2);
  });
});

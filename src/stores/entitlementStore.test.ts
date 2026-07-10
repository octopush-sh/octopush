/**
 * Unit tests for entitlementStore (premium scaffolding — P0).
 *
 * 1. load() fetches entitlement + usage and marks loaded
 * 2. hasFeature derives from the loaded entitlement
 * 3. load() degrades to Free (loaded, no throw) when IPC fails
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Entitlement, DirectRunUsage } from "../lib/ipc";

// ─── Mocks ────────────────────────────────────────────────────────────

const getEntitlementMock = vi.fn<() => Promise<Entitlement>>();
const directRunUsageMock = vi.fn<() => Promise<DirectRunUsage>>();

vi.mock("../lib/ipc", () => ({
  ipc: {
    getEntitlement: getEntitlementMock,
    directRunUsage: directRunUsageMock,
  },
}));

const { useEntitlementStore } = await import("./entitlementStore");

beforeEach(() => {
  useEntitlementStore.setState({
    entitlement: { plan: "free", features: [], directRunsPerMonth: null },
    usage: null,
    loaded: false,
  });
  getEntitlementMock.mockReset();
  directRunUsageMock.mockReset();
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
});

import { describe, it, expect, vi } from "vitest";

const listProvidersMock = vi.fn();
vi.mock("../lib/ipc", () => ({ ipc: { listProviders: () => listProvidersMock() } }));

const { useProvidersStore } = await import("./providersStore");

describe("providersStore", () => {
  it("a stale refresh that resolves last does not overwrite a newer one", async () => {
    let resolveOld!: (v: unknown) => void;
    listProvidersMock
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce([{ name: "new", models: [] }]);
    const old = useProvidersStore.getState().refresh();
    await useProvidersStore.getState().refresh();
    resolveOld([{ name: "old", models: [] }]);
    await old;
    expect(useProvidersStore.getState().providers.map((p) => p.name)).toEqual(["new"]);
  });

  it("keeps the last good catalog when a read fails", async () => {
    listProvidersMock.mockResolvedValueOnce([{ name: "kept", models: [] }]);
    await useProvidersStore.getState().refresh();
    listProvidersMock.mockRejectedValueOnce(new Error("boom"));
    await useProvidersStore.getState().refresh();
    expect(useProvidersStore.getState().providers.map((p) => p.name)).toEqual(["kept"]);
  });
});

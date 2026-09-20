import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionStore } from "./attentionStore";

describe("attentionStore — how long a workspace has been waiting", () => {
  beforeEach(() => {
    useAttentionStore.setState({ flagsByWs: {}, lastChimeAt: 0, soundEnabled: false });
    vi.useRealTimers();
  });

  it("keeps `since` at the first ping while `at` follows every later one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t1");
    vi.setSystemTime(5_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t1");
    const flag = useAttentionStore.getState().flagsByWs["ws-a"];
    expect(flag.at).toBe(5_000);
    expect(flag.since).toBe(1_000);
    vi.useRealTimers();
  });

  it("starts a fresh wait once the flag has been cleared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useAttentionStore.getState().ping("ws-a", "chat");
    useAttentionStore.getState().clear("ws-a");
    vi.setSystemTime(9_000);
    useAttentionStore.getState().ping("ws-a", "chat");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].since).toBe(9_000);
    vi.useRealTimers();
  });

  it("adopts an older flag's `at` as its `since` when the flag predates the field", () => {
    useAttentionStore.setState({ flagsByWs: { "ws-a": { kind: "chat", at: 42 } } });
    useAttentionStore.getState().ping("ws-a", "chat");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].since).toBe(42);
  });
});

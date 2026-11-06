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

describe("attentionStore — one wait per waiting session", () => {
  beforeEach(() => {
    useAttentionStore.setState({ flagsByWs: {}, waitsByTerminal: {}, lastChimeAt: 0, soundEnabled: false });
    vi.useRealTimers();
  });

  it("keeps two waits when two sessions in one workspace wait on you", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t1", "permission");
    vi.setSystemTime(2_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t2", "input");
    vi.useRealTimers();
    const { waitsByTerminal, flagsByWs } = useAttentionStore.getState();
    expect(waitsByTerminal).toEqual({
      t1: { workspaceId: "ws-a", reason: "permission", since: 1_000 },
      t2: { workspaceId: "ws-a", reason: "input", since: 2_000 },
    });
    // The workspace flag still holds the latest ping, as before.
    expect(flagsByWs["ws-a"].terminalId).toBe("t2");
  });

  it("clears one session's wait without touching the other's", () => {
    const s = useAttentionStore.getState();
    s.ping("ws-a", "terminal", "t1", "permission");
    s.ping("ws-a", "terminal", "t2", "permission");
    s.clearWait("t2");
    expect(Object.keys(useAttentionStore.getState().waitsByTerminal)).toEqual(["t1"]);
    // The workspace flag was t2's own hook ping, so it goes with t2's wait.
    expect(useAttentionStore.getState().flagsByWs["ws-a"]).toBeUndefined();
  });

  it("keeps the workspace flag when it belongs to a later bell, not the wait", () => {
    const s = useAttentionStore.getState();
    s.ping("ws-a", "terminal", "t1", "permission");
    s.ping("ws-a", "terminal", "t2");
    s.clearWait("t1");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].terminalId).toBe("t2");
  });

  it("keeps a wait's start across later pings, and leaves it to bells and idle pings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t1", "permission");
    vi.setSystemTime(5_000);
    useAttentionStore.getState().ping("ws-a", "terminal", "t1", "input");
    useAttentionStore.getState().ping("ws-a", "terminal", "t1");
    useAttentionStore.getState().ping("ws-a", "terminal", "t1", "idle");
    vi.useRealTimers();
    expect(useAttentionStore.getState().waitsByTerminal.t1).toEqual({
      workspaceId: "ws-a",
      reason: "input",
      since: 1_000,
    });
  });

  it("opens no wait for a bell, an idle ping or a chat", () => {
    const s = useAttentionStore.getState();
    s.ping("ws-a", "terminal", "t1");
    s.ping("ws-a", "terminal", "t2", "idle");
    s.ping("ws-b", "chat");
    expect(useAttentionStore.getState().waitsByTerminal).toEqual({});
  });

  it("clearing the workspace flag leaves the waits; closing a session drops its own", () => {
    const s = useAttentionStore.getState();
    s.ping("ws-a", "terminal", "t1", "permission");
    s.ping("ws-a", "terminal", "t2", "permission");
    s.clear("ws-a");
    expect(Object.keys(useAttentionStore.getState().waitsByTerminal)).toEqual(["t1", "t2"]);
    s.clearForTerminal("ws-a", "t1");
    expect(Object.keys(useAttentionStore.getState().waitsByTerminal)).toEqual(["t2"]);
  });
});

describe("attentionStore — why a terminal wants you", () => {
  beforeEach(() => {
    useAttentionStore.setState({ flagsByWs: {}, lastChimeAt: 0, soundEnabled: false });
  });

  it("keeps the reason of the latest ping, and none for a bell or a chat", () => {
    const { ping } = useAttentionStore.getState();
    ping("ws-a", "terminal", "t1", "permission");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].reason).toBe("permission");
    ping("ws-a", "terminal", "t1", "input");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].reason).toBe("input");
    ping("ws-a", "terminal", "t1");
    expect(useAttentionStore.getState().flagsByWs["ws-a"].reason).toBeNull();
    ping("ws-b", "chat");
    expect(useAttentionStore.getState().flagsByWs["ws-b"].reason).toBeNull();
  });
});

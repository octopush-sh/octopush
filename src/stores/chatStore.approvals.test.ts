/**
 * A Talk approval card reaches the user: it raises the workspace's needs-you
 * flag (rail, Mode switcher, Mission Control) until it is answered, chimes
 * unless the user is looking at it, posts a native notification while the
 * app is in the background, comes back after a reload, and Mission Control
 * or the menu bar can open its conversation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type EventHandler = (ev: { payload: unknown }) => void;
const handlers: Record<string, EventHandler> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    handlers[eventName] = handler;
    return Promise.resolve(() => {});
  }),
}));

const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: (n: unknown) => sendNotification(n) }));

vi.mock("../lib/ipc", () => ({
  ipc: {
    listChatMessages: vi.fn().mockResolvedValue([]),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    pendingSubagentCaps: vi.fn().mockResolvedValue([]),
    pendingApprovals: vi.fn().mockResolvedValue([]),
  },
}));

const { useChatStore } = await import("./chatStore");
const { useAttentionStore } = await import("./attentionStore");
const { useNotifyPrefs } = await import("./notifyPrefsStore");
const { focus } = await import("../lib/focus");
const { ipc } = await import("../lib/ipc");

function emit(eventName: string, payload: unknown) {
  const h = handlers[eventName];
  if (!h) throw new Error(`No handler registered for ${eventName}`);
  h({ payload });
}

const request = (callId: string, threadId = "t1", command = "git push --force") => ({
  workspaceId: "ws-1",
  threadId,
  callId,
  command,
  reason: "rewrites published history",
});

const flag = () => useAttentionStore.getState().flagsByWs["ws-1"];

beforeEach(() => {
  useChatStore.setState({ pendingApprovalsByWs: {}, activeThreadByWs: { "ws-1": "t1" }, messagesByWs: {} });
  useAttentionStore.setState({ flagsByWs: {}, waitsByTerminal: {}, lastChimeAt: 0, soundEnabled: true });
  useNotifyPrefs.setState({ crewNotifications: true });
  focus.workspaceId = null;
  focus.mode = "talk";
  sendNotification.mockClear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

describe("an approval card raises the workspace's needs-you state", () => {
  it("raises it on the request and settles it once the last card is answered", () => {
    emit("chat://approval-request", request("c1"));
    expect(flag()).toMatchObject({ kind: "chat", reason: "approval", detail: "git push --force" });

    emit("chat://approval-request", request("c2", "t2", "rm -rf build"));
    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "c1" });
    expect(flag()?.reason).toBe("approval");

    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "c2" });
    expect(flag()).toBeUndefined();
  });

  it("an answer from the card settles it at once, and a failed send raises it again", async () => {
    emit("chat://approval-request", request("c1"));
    useChatStore.getState().respondApproval("ws-1", "c1", "deny");
    expect(flag()).toBeUndefined();

    (ipc.respondApproval as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    emit("chat://approval-request", request("c2"));
    useChatStore.getState().respondApproval("ws-1", "c2", "approve");
    await vi.waitFor(() => expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(1));
    expect(flag()?.reason).toBe("approval");
  });

  it("Stop settles it with the card it retires", () => {
    emit("chat://approval-request", request("c1"));
    useChatStore.getState().stop("ws-1");
    expect(flag()).toBeUndefined();
  });

  it("Mission Control names the oldest card still waiting, never one already answered", () => {
    emit("chat://approval-request", request("c1", "t1", "git push --force"));
    emit("chat://approval-request", request("c2", "t2", "git reset --hard"));
    expect(flag()?.detail).toBe("git push --force");
    const since = flag()?.since;
    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "c1" });
    expect(flag()).toMatchObject({ reason: "approval", detail: "git reset --hard", since });
  });

  it("a duplicate request neither chimes nor notifies twice", () => {
    emit("chat://approval-request", request("c1"));
    const chimedAt = useAttentionStore.getState().lastChimeAt;
    emit("chat://approval-request", request("c1"));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(useAttentionStore.getState().lastChimeAt).toBe(chimedAt);
    expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(1);
  });
});

describe("it reaches you where you are", () => {
  it("chimes when you aren't looking at the conversation", () => {
    focus.workspaceId = "ws-2";
    emit("chat://approval-request", request("c1"));
    expect(useAttentionStore.getState().lastChimeAt).toBeGreaterThan(0);
  });

  it("stays quiet when you are looking right at it", () => {
    focus.workspaceId = "ws-1";
    focus.mode = "talk";
    emit("chat://approval-request", request("c1"));
    expect(useAttentionStore.getState().lastChimeAt).toBe(0);
    // Still the workspace's needs-you state: leave without answering and it says so.
    expect(flag()?.reason).toBe("approval");
  });

  it("posts a native notification even while the app looks focused (a locked screen does), without the command", () => {
    // `document.hasFocus()` is true here, as on a locked screen.
    emit("chat://approval-request", request("c1"));
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Talk needs a decision",
      body: "A workspace — A command is waiting for your approval",
    });
    expect(JSON.stringify(sendNotification.mock.calls)).not.toContain("git push");
  });

  it("a file card keeps its kind and mark, and its notification names neither the path nor the file (#1147)", () => {
    emit("chat://approval-request", { ...request("c1", "t1", "~/.ssh/id_ed25519"), kind: "read", sensitive: true });
    expect(useChatStore.getState().getPendingApprovals("ws-1")[0]).toMatchObject({ kind: "read", sensitive: true });
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Talk needs a decision",
      body: "A workspace — A file access outside the workspace is waiting for your approval",
    });
    expect(JSON.stringify(sendNotification.mock.calls)).not.toContain(".ssh");
  });

  it("respects the notification setting", () => {
    useNotifyPrefs.setState({ crewNotifications: false });
    emit("chat://approval-request", request("c1"));
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("a waiting card is never lost", () => {
  it("comes back when its conversation opens after a reload, and raises the flag", async () => {
    (ipc.pendingApprovals as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...request("c9", "t3", "git reset --hard"), secret: false },
    ]);
    await useChatStore.getState().selectThread("ws-1", "t3");
    await vi.waitFor(() => expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(1));
    expect(useChatStore.getState().getPendingApprovals("ws-1")[0]).toMatchObject({ callId: "c9", threadId: "t3" });
    expect(flag()).toMatchObject({ reason: "approval", detail: "git reset --hard" });
  });

  it("a reloaded MCP or file card keeps its kind", async () => {
    (ipc.pendingApprovals as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...request("c10", "t5", "mcp__github__merge_pr {}"), kind: "mcp" },
      { ...request("c11", "t5", "/etc/hosts"), kind: "write" },
    ]);
    await useChatStore.getState().selectThread("ws-1", "t5");
    await vi.waitFor(() => expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(2));
    const [mcp, write] = useChatStore.getState().getPendingApprovals("ws-1");
    expect([mcp.kind, write.kind]).toEqual(["mcp", "write"]);
    expect(write.sensitive).toBeUndefined();
  });

  it("a rehydrate racing an answer never brings the answered card back, nor its flag", async () => {
    // The reload read the list while the card still waited…
    let release!: (cards: unknown[]) => void;
    (ipc.pendingApprovals as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const opening = useChatStore.getState().selectThread("ws-1", "t4");
    emit("chat://approval-request", request("c7", "t4"));
    // …then the card was answered, before the read landed.
    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "c7" });
    await vi.waitFor(() => expect(ipc.pendingApprovals).toHaveBeenCalledWith("t4"));
    release([request("c7", "t4")]);
    await opening;
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(0);
    expect(flag()).toBeUndefined();
  });

  it("an answer clicked while a rehydrate is in flight stays answered", async () => {
    let release!: (cards: unknown[]) => void;
    (ipc.pendingApprovals as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    emit("chat://approval-request", request("c8", "t5"));
    const opening = useChatStore.getState().selectThread("ws-1", "t5");
    useChatStore.getState().respondApproval("ws-1", "c8", "approve");
    await vi.waitFor(() => expect(ipc.pendingApprovals).toHaveBeenCalledWith("t5"));
    release([request("c8", "t5")]);
    await opening;
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(0);
    expect(flag()).toBeUndefined();
  });

  it("Mission Control and the menu bar open the conversation the oldest card waits in", async () => {
    emit("chat://approval-request", request("c1", "t2"));
    emit("chat://approval-request", request("c2", "t3"));
    useChatStore.getState().showPendingApproval("ws-1");
    await vi.waitFor(() => expect(useChatStore.getState().activeThreadByWs["ws-1"]).toBe("t2"));
    // Already there: nothing to do.
    const select = vi.spyOn(useChatStore.getState(), "selectThread");
    useChatStore.getState().showPendingApproval("ws-1");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("a turn parked on an approval isn't working", () => {
  it("leaves the rail's working set, so the needs-you flag shows instead of the marching edge", async () => {
    const { workingTalkWorkspaces } = await import("./chatStore");
    const card = { callId: "c", threadId: "t", command: "git push -f", reason: "force-push" };
    expect(
      workingTalkWorkspaces({ "ws-1": true, "ws-2": true, "ws-3": false }, { "ws-1": [card], "ws-2": [] }),
    ).toEqual(["ws-2"]);
  });
});

describe("the secret guard asking again under the same call id", () => {
  it("shows the card again after the first answer", () => {
    const secret = { ...request("s1"), secret: true, reason: "possible secret · GitHub token in a.ts:3" };
    emit("chat://approval-request", secret);
    useChatStore.getState().respondApproval("ws-1", "s1", "approve");
    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "s1" });
    // The rescan found something new: the guard parks the same call again.
    emit("chat://approval-request", secret);
    expect(useChatStore.getState().getPendingApprovals("ws-1").map((a) => a.callId)).toEqual(["s1"]);
    expect(flag()?.reason).toBe("approval");
  });
});

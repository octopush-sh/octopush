/**
 * Regression tests for chatStore.
 *
 * Architectural invariants under test:
 * 1. Every chat message has a stable, unique id supplied by the backend
 *    (DB rowid). The frontend never invents ids via Date.now().
 * 2. State is SCOPED PER WORKSPACE. Two workspaces never share messages,
 *    streaming flag, streamBuffer, or error.
 *
 * If any future change reintroduces Date.now() ids, strips messages on the
 * done event, or globalizes state, these tests fail loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamEvent } from "../lib/types";
import type { MessageAddedEvent } from "./chatStore";

// ─── Mocks ────────────────────────────────────────────────────────────
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
    sendChatMessage: vi.fn().mockResolvedValue(undefined),
    truncateChatAfter: vi.fn().mockResolvedValue(undefined),
    listChatMessages: vi.fn().mockResolvedValue([]),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    listChatThreads: vi.fn().mockResolvedValue([]),
    createChatThread: vi.fn().mockResolvedValue({
      id: "t1", workspaceId: "ws-1", title: "New conversation",
      createdAt: "2026-05-17T09:00:00Z", updatedAt: "2026-05-17T09:00:00Z",
    }),
    renameChatThread: vi.fn().mockResolvedValue(undefined),
    deleteChatThread: vi.fn().mockResolvedValue(undefined),
    respondSubagentCap: vi.fn().mockResolvedValue(undefined),
  },
}));

const { useChatStore, EFFORT_MAX_TOKENS } = await import("./chatStore");
const { ipc } = await import("../lib/ipc");

function emit(eventName: string, payload: unknown) {
  const h = handlers[eventName];
  if (!h) throw new Error(`No handler registered for ${eventName}`);
  h({ payload });
}

function resetStore() {
  useChatStore.setState({
    messagesByWs: {},
    streamingByWs: {},
    streamBufferByWs: {},
    errorByWs: {},
    liveToolsByWs: {},
    threadsByWs: {},
    activeThreadByWs: {},
    streamingThreadByWs: {},
    activeSkillByWs: {},
    attachmentsByWs: {},
  });
}

function makeMsg(overrides: Partial<MessageAddedEvent>): MessageAddedEvent {
  return {
    workspaceId: "ws-1",
    id: 1,
    role: "user",
    content: "",
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: "2026-05-17T10:00:00Z",
    ...overrides,
  };
}

describe("chatStore — live `$`-direct process lifecycle", () => {
  beforeEach(() => resetStore());

  it("opens a live process on shell-live-start and closes it on shell-exit", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });

    emit("chat://shell-live-start", {
      workspaceId: "ws-1",
      threadId: "t1",
      callId: "shell-1",
      command: "npm run dev",
    });

    const live = useChatStore.getState().getLiveProcess("ws-1");
    expect(live).not.toBeNull();
    expect(live?.command).toBe("npm run dev");
    expect(live?.callId).toBe("shell-1");

    emit("chat://shell-exit", {
      threadId: "t1",
      callId: "shell-1",
      exitCode: 0,
      cwd: "/repo/packages/api",
      cwdLabel: "packages/api",
    });

    expect(useChatStore.getState().getLiveProcess("ws-1")).toBeNull();
    // The exit's backend-computed label updates the badge source.
    expect(useChatStore.getState().getShellCwd("ws-1")).toBe("packages/api");
  });

  it("surfaces a dangerous-command approval and retires it on resolve", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });

    emit("chat://approval-request", {
      workspaceId: "ws-1",
      threadId: "t1",
      callId: "call-1",
      command: "rm -rf build",
      reason: "recursive force delete (rm -rf)",
    });
    let pending = useChatStore.getState().getPendingApprovals("ws-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].command).toBe("rm -rf build");
    expect(pending[0].reason).toContain("rm -rf");

    emit("chat://approval-resolved", { workspaceId: "ws-1", callId: "call-1" });
    expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(0);
  });

  it("surfaces approvals workspace-wide (not hidden by a thread switch)", () => {
    // A destructive-command prompt is a safety signal — it must stay visible
    // even if the user navigates to another thread while it's pending.
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t-other" } });
    emit("chat://approval-request", {
      workspaceId: "ws-1",
      threadId: "t1",
      callId: "call-1",
      command: "rm -rf x",
      reason: "rm -rf",
    });
    expect(useChatStore.getState().getPendingApprovals("ws-1")).toHaveLength(1);
  });

  it("stop() retires the active thread's pending approval, not other threads'", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });
    emit("chat://approval-request", {
      workspaceId: "ws-1", threadId: "t1", callId: "call-1",
      command: "rm -rf x", reason: "rm -rf",
    });
    // A pending approval on a DIFFERENT thread must survive Stop on the active one.
    emit("chat://approval-request", {
      workspaceId: "ws-1", threadId: "t2", callId: "call-2",
      command: "git push --force", reason: "force-push",
    });
    useChatStore.getState().stop("ws-1");
    const remaining = useChatStore.getState().getPendingApprovals("ws-1");
    expect(remaining.map((a) => a.callId)).toEqual(["call-2"]);
  });

  it("scopes the live process to its thread", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t-other" } });
    emit("chat://shell-live-start", {
      workspaceId: "ws-1",
      threadId: "t1",
      callId: "shell-1",
      command: "tail -f log",
    });
    // Active thread is t-other, so the t1 process isn't surfaced here.
    expect(useChatStore.getState().getLiveProcess("ws-1")).toBeNull();
  });
});

// ─── Tests ────────────────────────────────────────────────────────────
describe("chatStore — single workspace tool-card persistence", () => {
  beforeEach(() => resetStore());

  it("preserves tool messages through the full agentic loop sequence", async () => {
    const workspaceId = "ws-1";
    const workspacePath = "/tmp/octopus-test";

    await useChatStore.getState().send(workspaceId, workspacePath, "build me a thing");
    expect(useChatStore.getState().getStreaming(workspaceId)).toBe(true);
    expect(useChatStore.getState().getMessages(workspaceId)).toHaveLength(0);

    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "build me a thing" }));
    expect(useChatStore.getState().getMessages(workspaceId)).toHaveLength(1);
    expect(useChatStore.getState().getMessages(workspaceId)[0].role).toBe("user");

    const tools = [
      { toolName: "list_files", toolInput: { path: "." }, result: "a\nb\nc" },
      { toolName: "read_file", toolInput: { path: "a" }, result: "// file a" },
      { toolName: "write_file", toolInput: { path: "b", content: "(123 chars)" }, result: "wrote" },
    ];
    tools.forEach((tool, i) => {
      emit("chat://message-added", makeMsg({
        id: 2 + i,
        role: "tool",
        content: JSON.stringify(tool),
      }));
    });

    expect(useChatStore.getState().getMessages(workspaceId)).toHaveLength(4);

    emit("chat://stream", {
      workspaceId,
      delta: "Done. Built the thing.",
      done: false,
      inputTokens: null,
      outputTokens: null,
    } satisfies ChatStreamEvent);

    emit("chat://message-added", makeMsg({
      id: 5,
      role: "assistant",
      content: "Done. Built the thing.",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
    }));

    emit("chat://stream", {
      workspaceId,
      delta: "",
      done: true,
      inputTokens: 1000,
      outputTokens: 200,
    } satisfies ChatStreamEvent);

    const afterDone = useChatStore.getState().getMessages(workspaceId);
    const roleCounts = afterDone.reduce<Record<string, number>>((acc, m) => {
      const r = String(m.role);
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});

    expect(roleCounts).toEqual({ user: 1, tool: 3, assistant: 1 });
    expect(afterDone).toHaveLength(5);
    expect(useChatStore.getState().getStreaming(workspaceId)).toBe(false);
    expect(useChatStore.getState().getStreamBuffer(workspaceId)).toBe("");
  });

  it("uses unique backend-provided ids — no Date.now() collisions", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({ id: 2, role: "tool", content: JSON.stringify({ toolName: "read_file", toolInput: {}, result: "" }) }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const ids = useChatStore.getState().getMessages("ws-1").map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(3);
  });

  it("React keys are unique across timeline", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({ id: 2, role: "tool", content: JSON.stringify({ toolName: "read_file", toolInput: {}, result: "" }) }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    const keys = timeline.map((it) =>
      it.kind === "tool" || it.kind === "crew" || it.kind === "narration" ? `${it.kind}-${it.id}` : String(it.message.id),
    );
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `Duplicate React keys: ${JSON.stringify(keys)}`).toEqual([]);
  });

  it("is idempotent under duplicate message-added events", () => {
    const ev = makeMsg({ id: 42, role: "user", content: "hi" });
    emit("chat://message-added", ev);
    emit("chat://message-added", ev);
    emit("chat://message-added", ev);

    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(1);
  });

  it("getTimeline parses tool messages into tool items", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "tool",
      content: JSON.stringify({ toolName: "read_file", toolInput: { path: "x" }, result: "ok" }),
    }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    expect(timeline).toHaveLength(3);
    expect(timeline[0].kind).toBe("message");
    expect(timeline[1].kind).toBe("tool");
    expect(timeline[2].kind).toBe("message");
  });

  it("error message received via chat://message-added is stored in messagesByWs", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "error",
      content: "401 unauthorized — API key not configured",
    }));

    const messages = useChatStore.getState().getMessages("ws-1");
    expect(messages).toHaveLength(2);
    const errMsg = messages.find((m) => (m.role as string) === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toContain("API key not configured");
  });

  it("getTimeline emits an error kind for role=error messages", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "go" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "error",
      content: "Network timeout",
    }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].kind).toBe("message");
    expect(timeline[1].kind).toBe("error");
    if (timeline[1].kind === "error") {
      expect(timeline[1].message.content).toBe("Network timeout");
    }
  });
});

describe("chatStore — live tool cards (P2)", () => {
  beforeEach(() => resetStore());

  it("tool-start adds a live tool; tool-end marks it done with timing", () => {
    emit("chat://tool-start", {
      workspaceId: "ws-1",
      callId: "call_a",
      toolName: "run_command",
      toolInput: { command: "npm test" },
      startedAt: "2026-05-17T10:00:00Z",
    });

    let live = useChatStore.getState().getLiveTools("ws-1");
    expect(live).toHaveLength(1);
    expect(live[0].callId).toBe("call_a");
    expect(live[0].done).toBe(false);

    emit("chat://tool-end", {
      workspaceId: "ws-1",
      callId: "call_a",
      ok: true,
      durationMs: 1234,
    });

    live = useChatStore.getState().getLiveTools("ws-1");
    expect(live[0].done).toBe(true);
    expect(live[0].ok).toBe(true);
    expect(live[0].durationMs).toBe(1234);
  });

  it("a resolved tool row (message-added) retires its live card by callId", () => {
    emit("chat://tool-start", {
      workspaceId: "ws-1", callId: "call_b", toolName: "read_file",
      toolInput: { path: "a.ts" }, startedAt: "2026-05-17T10:00:00Z",
    });
    expect(useChatStore.getState().getLiveTools("ws-1")).toHaveLength(1);

    emit("chat://message-added", makeMsg({
      id: 7, role: "tool",
      content: JSON.stringify({ callId: "call_b", toolName: "read_file", toolInput: { path: "a.ts" }, result: "ok" }),
    }));

    // Live card gone; resolved row present.
    expect(useChatStore.getState().getLiveTools("ws-1")).toHaveLength(0);
    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(1);
  });

  it("live tools are scoped per workspace and cleared on done", () => {
    emit("chat://tool-start", {
      workspaceId: "ws-A", callId: "c1", toolName: "list_files",
      toolInput: { path: "." }, startedAt: "2026-05-17T10:00:00Z",
    });
    expect(useChatStore.getState().getLiveTools("ws-A")).toHaveLength(1);
    expect(useChatStore.getState().getLiveTools("ws-B")).toHaveLength(0);

    emit("chat://stream", { workspaceId: "ws-A", delta: "", done: true, inputTokens: null, outputTokens: null });
    expect(useChatStore.getState().getLiveTools("ws-A")).toHaveLength(0);
  });

  it("getLiveTools returns a stable empty reference for unknown workspaces", () => {
    const a = useChatStore.getState().getLiveTools("never");
    const b = useChatStore.getState().getLiveTools("never");
    expect(a).toBe(b);
  });
});

describe("chatStore — assistant_tool_use rendering", () => {
  beforeEach(() => resetStore());

  it("strips the [tool_calls: …] suffix and keeps the lead text", () => {
    emit("chat://message-added", makeMsg({
      id: 1, role: "assistant_tool_use",
      content: "Let me check the files.\n\n[tool_calls: [{\"toolName\":\"list_files\"}]]",
    }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    expect(timeline).toHaveLength(1);
    // The model's pre-tool text is narration — a quiet line, not a bubble.
    expect(timeline[0].kind).toBe("narration");
    if (timeline[0].kind === "narration") {
      expect(timeline[0].text).toBe("Let me check the files.");
    }
  });

  it("hides pure-bookkeeping assistant_tool_use rows (no lead text)", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "go" }));
    emit("chat://message-added", makeMsg({
      id: 2, role: "assistant_tool_use",
      content: "[tool_calls: [{\"toolName\":\"read_file\"}]]",
    }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    // Only the user message survives — the bookkeeping row is hidden.
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("message");
  });
});

describe("chatStore — stop + effort (P3)", () => {
  beforeEach(() => {
    resetStore();
    useChatStore.setState({ effort: "standard" });
    vi.clearAllMocks();
  });

  it("stop() cancels the workspace's active thread", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });
    useChatStore.getState().stop("ws-1");
    expect(ipc.cancelChat).toHaveBeenCalledWith("t1");
  });

  it("send() passes the workspace's active skill (P6)", async () => {
    useChatStore.getState().setActiveSkill("ws-1", "write-tests");
    await useChatStore.getState().send("ws-1", "/tmp", "go");
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "write-tests" }),
    );
    expect(useChatStore.getState().getActiveSkill("ws-1")).toBe("write-tests");
  });

  it("send() passes pending attachments then clears them (P7)", async () => {
    useChatStore.getState().addAttachment("ws-1", { mediaType: "image/png", data: "QUJD", name: "a.png" });
    expect(useChatStore.getState().getAttachments("ws-1")).toHaveLength(1);
    await useChatStore.getState().send("ws-1", "/tmp", "look at this");
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ mediaType: "image/png", data: "QUJD" }] }),
    );
    expect(useChatStore.getState().getAttachments("ws-1")).toHaveLength(0);
  });

  it("send() uses the effort's max-tokens budget", async () => {
    useChatStore.getState().setEffort("deep");
    await useChatStore.getState().send("ws-1", "/tmp", "hi");
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: EFFORT_MAX_TOKENS.deep }),
    );

    vi.clearAllMocks();
    useChatStore.getState().setEffort("swift");
    await useChatStore.getState().send("ws-1", "/tmp", "hi");
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: EFFORT_MAX_TOKENS.swift }),
    );
  });
});

describe("chatStore — conversation threads (P5)", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("loadHistory ensures a thread, sets it active, and loads its messages", async () => {
    (ipc.listChatThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await useChatStore.getState().loadHistory("ws-1");
    // No threads existed → one was created and made active.
    expect(ipc.createChatThread).toHaveBeenCalledWith("ws-1", "New conversation");
    expect(useChatStore.getState().getActiveThread("ws-1")).toBe("t1");
    expect(useChatStore.getState().getThreads("ws-1")).toHaveLength(1);
  });

  it("newThread prepends, activates, and clears the view", async () => {
    useChatStore.setState({
      messagesByWs: { "ws-1": [{ id: 9 } as never] },
      threadsByWs: { "ws-1": [{ id: "old", workspaceId: "ws-1", title: "Old", createdAt: "", updatedAt: "" }] },
      activeThreadByWs: { "ws-1": "old" },
    });
    await useChatStore.getState().newThread("ws-1");
    expect(useChatStore.getState().getActiveThread("ws-1")).toBe("t1");
    expect(useChatStore.getState().getThreads("ws-1")[0].id).toBe("t1");
    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(0);
  });

  it("events for a non-active thread are ignored (filtered by threadId)", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "active" } });
    // An event for a DIFFERENT thread must not append to the shown view.
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "bg", threadId: "other" }));
    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(0);
    // An event for the active thread applies.
    emit("chat://message-added", makeMsg({ id: 2, role: "user", content: "fg", threadId: "active" }));
    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(1);
  });

  it("deleteThread falls back to the remaining thread when the active one is removed", async () => {
    useChatStore.setState({
      threadsByWs: {
        "ws-1": [
          { id: "a", workspaceId: "ws-1", title: "A", createdAt: "", updatedAt: "" },
          { id: "b", workspaceId: "ws-1", title: "B", createdAt: "", updatedAt: "" },
        ],
      },
      activeThreadByWs: { "ws-1": "a" },
    });
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await useChatStore.getState().deleteThread("ws-1", "a");
    expect(ipc.deleteChatThread).toHaveBeenCalledWith("a");
    expect(useChatStore.getState().getThreads("ws-1").map((t) => t.id)).toEqual(["b"]);
    expect(useChatStore.getState().getActiveThread("ws-1")).toBe("b");
  });
});

describe("chatStore — workspace isolation", () => {
  beforeEach(() => resetStore());

  it("messages are scoped per workspace", () => {
    emit("chat://message-added", makeMsg({ workspaceId: "ws-A", id: 1, role: "user", content: "hello from A" }));
    emit("chat://message-added", makeMsg({ workspaceId: "ws-B", id: 2, role: "user", content: "hello from B" }));

    expect(useChatStore.getState().getMessages("ws-A")).toHaveLength(1);
    expect(useChatStore.getState().getMessages("ws-A")[0].content).toBe("hello from A");
    expect(useChatStore.getState().getMessages("ws-B")).toHaveLength(1);
    expect(useChatStore.getState().getMessages("ws-B")[0].content).toBe("hello from B");
  });

  it("streaming flag is scoped per workspace (the reported bug)", async () => {
    await useChatStore.getState().send("ws-A", "/tmp/a", "do something");

    // ws-A is now streaming. ws-B must NOT be.
    expect(useChatStore.getState().getStreaming("ws-A")).toBe(true);
    expect(useChatStore.getState().getStreaming("ws-B")).toBe(false);
  });

  it("streamBuffer is scoped per workspace", () => {
    emit("chat://stream", {
      workspaceId: "ws-A",
      delta: "alpha text",
      done: false,
      inputTokens: null,
      outputTokens: null,
    });

    expect(useChatStore.getState().getStreamBuffer("ws-A")).toBe("alpha text");
    expect(useChatStore.getState().getStreamBuffer("ws-B")).toBe("");
  });

  it("done event only clears the streaming of the originating workspace", async () => {
    await useChatStore.getState().send("ws-A", "/tmp/a", "X");
    await useChatStore.getState().send("ws-B", "/tmp/b", "Y");
    expect(useChatStore.getState().getStreaming("ws-A")).toBe(true);
    expect(useChatStore.getState().getStreaming("ws-B")).toBe(true);

    emit("chat://stream", {
      workspaceId: "ws-A",
      delta: "",
      done: true,
      inputTokens: null,
      outputTokens: null,
    });

    expect(useChatStore.getState().getStreaming("ws-A")).toBe(false);
    expect(useChatStore.getState().getStreaming("ws-B")).toBe(true);
  });

  it("empty selectors return stable references (no infinite re-render trap)", () => {
    // Calling getMessages on an unknown workspace twice returns THE SAME array
    // reference, so a React component subscribing via useChatStore((s) => s.getMessages(...))
    // doesn't see a "change" when there's no data.
    const a1 = useChatStore.getState().getMessages("never-seen");
    const a2 = useChatStore.getState().getMessages("never-seen");
    expect(a1).toBe(a2);

    const t1 = useChatStore.getState().getTimeline("never-seen");
    const t2 = useChatStore.getState().getTimeline("never-seen");
    expect(t1).toBe(t2);

    expect(useChatStore.getState().getStreaming("never-seen")).toBe(false);
    expect(useChatStore.getState().getStreamBuffer("never-seen")).toBe("");
    expect(useChatStore.getState().getError("never-seen")).toBeNull();
  });
});

describe("chatStore — message actions (regenerate / edit-and-resend)", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    useChatStore.setState({
      activeThreadByWs: { "ws-1": "t1" },
      messagesByWs: {
        "ws-1": [
          { id: 1, workspaceId: "ws-1", role: "user", content: "first",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:00Z" },
          { id: 2, workspaceId: "ws-1", role: "assistant", content: "answer",
            model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:01Z" },
        ],
      },
    });
  });

  it("regenerate truncates from the assistant turn and re-runs without a new user row", async () => {
    await useChatStore.getState().regenerate("ws-1", "/tmp", 2);

    expect(ipc.truncateChatAfter).toHaveBeenCalledWith("t1", 2);
    // The assistant turn is dropped locally, the prompting user message stays.
    const msgs = useChatStore.getState().getMessages("ws-1");
    expect(msgs.map((m) => m.id)).toEqual([1]);
    // Re-dispatched with regenerate:true (no new user message inserted).
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ regenerate: true, userMessage: "" }),
    );
  });

  it("regenerate truncates from the turn's first tool row, not the assistant text", async () => {
    // A turn with tool calls: user(1) → tool(2) → assistant(3). Regenerating the
    // assistant must drop the tool row too, or stale tool context leaks back in.
    useChatStore.setState({
      activeThreadByWs: { "ws-1": "t1" },
      messagesByWs: {
        "ws-1": [
          { id: 1, workspaceId: "ws-1", role: "user", content: "go",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:00Z" },
          { id: 2, workspaceId: "ws-1", role: "tool", content: "{}",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:01Z" },
          { id: 3, workspaceId: "ws-1", role: "assistant", content: "done",
            model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:02Z" },
        ],
      },
    });

    await useChatStore.getState().regenerate("ws-1", "/tmp", 3);

    // Truncates from the tool row (first row of the turn), keeping only the user.
    expect(ipc.truncateChatAfter).toHaveBeenCalledWith("t1", 2);
    expect(useChatStore.getState().getMessages("ws-1").map((m) => m.id)).toEqual([1]);
  });

  it("does not mutate the local store if the truncate IPC fails", async () => {
    (ipc.truncateChatAfter as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("locked"));
    await useChatStore.getState().regenerate("ws-1", "/tmp", 2);
    // Messages are untouched (no optimistic removal) and the turn isn't dispatched.
    expect(useChatStore.getState().getMessages("ws-1").map((m) => m.id)).toEqual([1, 2]);
    expect(ipc.sendChatMessage).not.toHaveBeenCalled();
  });

  it("editAndResend truncates from the user message and resends the new text", async () => {
    await useChatStore.getState().editAndResend("ws-1", "/tmp", 1, "edited prompt");

    expect(ipc.truncateChatAfter).toHaveBeenCalledWith("t1", 1);
    expect(ipc.sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "edited prompt" }),
    );
  });

  it("editAndResend is a no-op for blank content", async () => {
    await useChatStore.getState().editAndResend("ws-1", "/tmp", 1, "   ");
    expect(ipc.truncateChatAfter).not.toHaveBeenCalled();
    expect(ipc.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("chatStore — failed turn surfaces exactly one error", () => {
  const PROVIDER_ERR =
    'OpenAI-compat API error 402 Payment Required: {"error":{"message":"Insufficient Balance"}}';

  function mkRow(id: number, role: string, content: string) {
    return {
      id, role, content,
      model: null, inputTokens: null, outputTokens: null, costUsd: null,
      createdAt: "2026-07-20T10:00:00Z",
    };
  }

  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    (ipc.listChatThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t1", workspaceId: "ws-1", title: "New conversation",
        createdAt: "2026-07-20T09:00:00Z", updatedAt: "2026-07-20T09:00:00Z" },
    ]);
  });

  it("suppresses the transient banner when the backend persisted the same error row", async () => {
    (ipc.sendChatMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(PROVIDER_ERR);
    // The post-failure resync returns the persisted error as the last row —
    // rendering the banner too would show the same card twice.
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkRow(1, "user", "hola"),
      mkRow(2, "error", PROVIDER_ERR),
    ]);

    await useChatStore.getState().send("ws-1", "/tmp", "hola");

    expect(useChatStore.getState().getError("ws-1")).toBeNull();
    expect(useChatStore.getState().getStreaming("ws-1")).toBe(false);
    // The persisted row is what carries the error into the conversation.
    const roles = useChatStore.getState().getMessages("ws-1").map((m) => m.role);
    expect(roles).toEqual(["user", "error"]);
  });

  it("keeps the banner when the failure was never persisted", async () => {
    (ipc.sendChatMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce("db locked");
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkRow(1, "user", "hola"),
    ]);

    await useChatStore.getState().send("ws-1", "/tmp", "hola");

    expect(useChatStore.getState().getError("ws-1")).toBe("db locked");
    expect(useChatStore.getState().getStreaming("ws-1")).toBe(false);
  });

  it("keeps the banner when the post-failure resync itself fails", async () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });
    (ipc.sendChatMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(PROVIDER_ERR);
    (ipc.listChatThreads as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db gone"));

    await useChatStore.getState().send("ws-1", "/tmp", "hola");

    expect(useChatStore.getState().getError("ws-1")).toBe(PROVIDER_ERR);
  });
});

// ─── Sub-agents: crew grouping + live journal ────────────────────────
// Same lazy import as the top of the file: a static import would hoist above
// the `handlers` map the listen mock writes into.
const { buildTimeline, appendAgentLog, AGENT_LOG_CAP } = await import("./chatStore");

describe("chatStore — sub-agents", () => {
  const agentRow = (id: number, callId: string, description: string, toolName = "Agent") =>
    makeMsg({
      id,
      role: "tool",
      content: JSON.stringify({
        callId,
        toolName,
        toolInput: { description, subagentType: "reviewer", promptChars: 120 },
        result: `report ${id}`,
        agent: { ok: true, finished: true, closedAtCap: false, blocked: false, model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 1200, toolCalls: 2 },
      }),
    });

  it("groups adjacent Agent/Task rows of one response into ONE crew item", () => {
    const msgs = [
      makeMsg({ id: 1, role: "user", content: "review it" }),
      agentRow(2, "c1", "correctness"),
      agentRow(3, "c2", "security", "Task"),
      agentRow(4, "c3", "tests"),
      makeMsg({ id: 5, role: "assistant", content: "synthesis" }),
    ].map((e) => ({ ...e }) as unknown as import("../lib/types").ChatMessage);
    const items = buildTimeline(msgs);
    expect(items.map((i) => i.kind)).toEqual(["message", "crew", "message"]);
    const crew = items[1];
    if (crew.kind !== "crew") throw new Error("expected crew");
    expect(crew.id).toBe(2);
    expect(crew.agents.map((a) => a.tool.callId)).toEqual(["c1", "c2", "c3"]);
    expect(crew.agents[1].tool.toolName).toBe("Task");
  });

  it("a non-agent tool row between fan-outs splits them into separate crews", () => {
    const msgs = [
      agentRow(1, "c1", "a"),
      makeMsg({ id: 2, role: "tool", content: JSON.stringify({ toolName: "read_file", toolInput: { path: "x" }, result: "" }) }),
      agentRow(3, "c2", "b"),
    ].map((e) => ({ ...e }) as unknown as import("../lib/types").ChatMessage);
    const items = buildTimeline(msgs);
    expect(items.map((i) => i.kind)).toEqual(["crew", "tool", "crew"]);
  });

  it("chat://agent-log appends under the call id, bounded by the cap", () => {
    emit("chat://agent-log", { workspaceId: "ws-1", threadId: "t", callId: "c1", entry: { kind: "text", text: "reading" } });
    emit("chat://agent-log", { workspaceId: "ws-1", threadId: "t", callId: "c1", entry: { kind: "tool", tool: "read_file", hint: "a.rs" } });
    emit("chat://agent-log", { workspaceId: "ws-1", threadId: "t", callId: "c2", entry: { kind: "text", text: "other" } });
    // Malformed entries are ignored, never stored.
    emit("chat://agent-log", { workspaceId: "ws-1", threadId: "t", callId: "c1", entry: { nope: true } });
    const s = useChatStore.getState();
    expect(s.getAgentLog("c1").map((e) => e.kind)).toEqual(["text", "tool"]);
    expect(s.getAgentLog("c2")).toHaveLength(1);
    expect(s.getAgentLog("missing")).toEqual([]);

    let logs: Record<string, import("../lib/ipc").LiveEntry[]> = {};
    for (let i = 0; i < AGENT_LOG_CAP + 25; i++) {
      logs = appendAgentLog(logs, "big", { kind: "text", text: String(i) });
    }
    expect(logs.big).toHaveLength(AGENT_LOG_CAP);
    expect(logs.big[0]).toEqual({ kind: "text", text: "25" });
  });

  it("focusCrewAgent is scoped per workspace and clears with null", () => {
    const s = useChatStore.getState();
    s.focusCrewAgent("ws-1", "c1");
    s.focusCrewAgent("ws-2", "c9");
    expect(useChatStore.getState().getCrewFocus("ws-1")).toBe("c1");
    expect(useChatStore.getState().getCrewFocus("ws-2")).toBe("c9");
    s.focusCrewAgent("ws-1", null);
    expect(useChatStore.getState().getCrewFocus("ws-1")).toBeNull();
    expect(useChatStore.getState().getCrewFocus("ws-2")).toBe("c9");
  });
});

describe("chatStore — sub-agent continuation", () => {
  beforeEach(() => resetStore());

  const agentRow = (id: number, callId: string, result: string, extra: Record<string, unknown> = {}) =>
    makeMsg({
      id,
      role: "tool",
      content: JSON.stringify({
        callId,
        toolName: "Agent",
        toolInput: { description: "Map the tests" },
        result,
        agent: { ok: false, closedAtCap: true, model: "haiku", inputTokens: 10, outputTokens: 2, costUsd: 0.01, durationMs: 5, toolCalls: 15, ...extra },
      }),
    });

  it("a tool-start on a call that already has a resolved row marks it continuing instead of opening a live card", () => {
    emit("chat://message-added", agentRow(1, "c1", "partial"));
    emit("chat://tool-start", { workspaceId: "ws-1", callId: "c1", toolName: "Agent", toolInput: {}, startedAt: "2026-01-01T00:00:00Z" });
    const s = useChatStore.getState();
    expect(s.continuingCalls.c1).toBe(true);
    expect(s.getLiveTools("ws-1")).toHaveLength(0);
  });

  it("message-updated replaces the row in place and clears the continuing mark", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "go" }));
    emit("chat://message-added", agentRow(2, "c1", "partial"));
    useChatStore.setState({ continuingCalls: { c1: true } });
    const updated = JSON.stringify({ callId: "c1", toolName: "Agent", toolInput: { description: "Map the tests" }, result: "complete", agent: { ok: true, continued: true, model: "haiku", inputTokens: 20, outputTokens: 4, costUsd: 0.02, durationMs: 9, toolCalls: 19 } });
    emit("chat://message-updated", { workspaceId: "ws-1", id: 2, content: updated });
    const s = useChatStore.getState();
    const msgs = s.getMessages("ws-1");
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe(updated);
    expect(s.continuingCalls.c1).toBeUndefined();
    const crew = s.getTimeline("ws-1").find((it) => it.kind === "crew");
    expect(crew && crew.kind === "crew" ? crew.agents[0].tool.agent?.continued : null).toBe(true);
  });

  it("an update for a row this workspace does not hold changes nothing", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "go" }));
    emit("chat://message-updated", { workspaceId: "ws-1", id: 99, content: "{}" });
    expect(useChatStore.getState().getMessages("ws-1")).toHaveLength(1);
  });
});

describe("chatStore — turn-limit cards", () => {
  beforeEach(() => resetStore());

  const capEvent = { workspaceId: "ws-1", threadId: "t1", callId: "c1", description: "Implement it", subagentType: "implementer", turnsUsed: 25 };

  it("surfaces a capped writing sub-agent and retires it on resolve", () => {
    useChatStore.setState({ activeThreadByWs: { "ws-1": "t1" } });
    emit("chat://subagent-cap", capEvent);
    emit("chat://subagent-cap", capEvent); // idempotent
    const caps = useChatStore.getState().getPendingCaps("ws-1");
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ callId: "c1", description: "Implement it", subagentType: "implementer", turnsUsed: 25 });
    emit("chat://subagent-cap-resolved", { workspaceId: "ws-1", callId: "c1" });
    expect(useChatStore.getState().getPendingCaps("ws-1")).toHaveLength(0);
  });

  it("answering retires the card optimistically and sends the grant (or the accept)", async () => {
    emit("chat://subagent-cap", capEvent);
    useChatStore.getState().respondSubagentCap("ws-1", "c1", 50);
    expect(useChatStore.getState().getPendingCaps("ws-1")).toHaveLength(0);
    expect(ipc.respondSubagentCap).toHaveBeenCalledWith("c1", 50);
    emit("chat://subagent-cap", capEvent);
    useChatStore.getState().respondSubagentCap("ws-1", "c1", null);
    expect(ipc.respondSubagentCap).toHaveBeenLastCalledWith("c1", null);
  });
});

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
    listChatMessages: vi.fn().mockResolvedValue([]),
    cancelChat: vi.fn().mockResolvedValue(undefined),
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
      it.kind === "tool" ? `tool-${it.id}` : String(it.message.id),
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
    expect(timeline[0].kind).toBe("message");
    if (timeline[0].kind === "message") {
      expect(timeline[0].message.content).toBe("Let me check the files.");
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

  it("stop() calls ipc.cancelChat for the workspace", () => {
    useChatStore.getState().stop("ws-1");
    expect(ipc.cancelChat).toHaveBeenCalledWith("ws-1");
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

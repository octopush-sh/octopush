/**
 * Regression test for the "tool cards disappearing" bug.
 *
 * Architectural invariant under test: every chat message has a stable,
 * unique id supplied by the backend (DB rowid). The frontend never
 * invents ids via Date.now(). This eliminates the class of bugs where
 * user-msg and assistant-msg shared the same React key, causing
 * reconciliation to drop tool cards in between.
 *
 * If any future change reintroduces Date.now() ids or strips messages
 * on the done event, these tests fail loudly.
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
  },
}));

// Import AFTER mocks are wired so chatStore picks them up.
const { useChatStore } = await import("./chatStore");

// ─── Helpers ──────────────────────────────────────────────────────────
function emit(eventName: string, payload: unknown) {
  const h = handlers[eventName];
  if (!h) throw new Error(`No handler registered for ${eventName}`);
  h({ payload });
}

function resetStore() {
  useChatStore.setState({
    messages: [],
    streaming: false,
    streamBuffer: "",
    error: null,
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
describe("chatStore — tool card persistence through done event", () => {
  beforeEach(() => {
    resetStore();
  });

  it("preserves tool messages through the full agentic loop sequence", async () => {
    const workspaceId = "ws-1";
    const workspacePath = "/tmp/octopus-test";

    // 1. User calls send → streaming begins, no optimistic local message.
    await useChatStore.getState().send(workspaceId, workspacePath, "build me a thing");
    expect(useChatStore.getState().streaming).toBe(true);
    expect(useChatStore.getState().messages).toHaveLength(0);

    // 2. Backend persists user msg → emits message-added (id=1).
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "build me a thing" }));
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].role).toBe("user");

    // 3. Backend persists 3 tool executions → emits message-added per tool.
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

    expect(useChatStore.getState().messages).toHaveLength(4);
    expect(useChatStore.getState().messages.slice(1).every((m) => String(m.role) === "tool")).toBe(true);

    // 4. Backend streams final delta, then emits message-added for assistant,
    //    then emits stream { done: true } as metadata.
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

    // 5. Final state: user + 3 tools + assistant = 5. Tools survive the done event.
    const afterDone = useChatStore.getState().messages;
    const roleCounts = afterDone.reduce<Record<string, number>>((acc, m) => {
      const r = String(m.role);
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});

    expect(roleCounts).toEqual({ user: 1, tool: 3, assistant: 1 });
    expect(afterDone).toHaveLength(5);
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().streamBuffer).toBe("");
  });

  it("uses unique, monotonic backend-provided ids — no Date.now() collisions", () => {
    // The new architecture: backend rowids are integers, monotonically
    // increasing per insert. They cannot collide with each other.
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({ id: 2, role: "tool", content: JSON.stringify({ toolName: "read_file", toolInput: {}, result: "" }) }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const msgs = useChatStore.getState().messages;
    const ids = msgs.map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(3); // unique
  });

  it("React keys are unique across timeline (no duplicate-key reconciliation bugs)", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({ id: 2, role: "tool", content: JSON.stringify({ toolName: "read_file", toolInput: {}, result: "" }) }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const timeline = useChatStore.getState().getTimeline();
    const keys = timeline.map((it) =>
      it.kind === "tool" ? `tool-${it.id}` : String(it.message.id),
    );
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `Duplicate React keys: ${JSON.stringify(keys)}`).toEqual([]);
  });

  it("is idempotent under duplicate message-added events (defends against HMR)", () => {
    const ev = makeMsg({ id: 42, role: "user", content: "hi" });
    emit("chat://message-added", ev);
    emit("chat://message-added", ev); // duplicate — should no-op
    emit("chat://message-added", ev); // duplicate again

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
  });

  it("getTimeline parses tool messages into tool items", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "tool",
      content: JSON.stringify({
        toolName: "read_file",
        toolInput: { path: "x" },
        result: "ok",
      }),
    }));
    emit("chat://message-added", makeMsg({ id: 3, role: "assistant", content: "done" }));

    const timeline = useChatStore.getState().getTimeline();
    expect(timeline).toHaveLength(3);
    expect(timeline[0].kind).toBe("message");
    expect(timeline[1].kind).toBe("tool");
    expect(timeline[2].kind).toBe("message");
  });
});

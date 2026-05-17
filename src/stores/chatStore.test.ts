/**
 * Regression test for the "tool cards disappearing" bug.
 *
 * Bug history: 11+ "fixes" in git (4077188, 61d4739, 03252b9, 8b67549, ...).
 * Symptom: tool cards appear progressively during the agentic loop, then
 *   disappear when the final `chat://stream { done: true }` event arrives.
 *   Only user prompt + final assistant message remain in the timeline.
 *
 * This test mocks Tauri's `listen` to capture the chatStore's event handlers,
 * then simulates the exact event sequence the backend emits:
 *   1. user calls send() → user msg appears, streaming begins
 *   2. backend emits tool-use × N → N tool messages appended
 *   3. backend emits stream { done: true } → final assistant msg appended
 *
 * Assertion: after `done`, `messages` MUST still contain all N tool entries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamEvent } from "../lib/types";
import type { ToolUseEvent } from "./chatStore";

// ─── Mocks ────────────────────────────────────────────────────────────
// Capture event handlers registered by chatStore during create().

type EventHandler = (ev: { payload: unknown }) => void;
const handlers: Record<string, EventHandler> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    handlers[eventName] = handler;
    return Promise.resolve(() => {}); // unlisten fn
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
    liveTools: [],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────
describe("chatStore — tool card persistence through done event", () => {
  beforeEach(() => {
    resetStore();
  });

  it("reproduces the agentic-loop event sequence and keeps tool cards after done", async () => {
    const workspaceId = "ws-1";
    const workspacePath = "/tmp/octopus-test";

    // 1. User sends a prompt.
    await useChatStore.getState().send(workspaceId, workspacePath, "build me a thing");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].role).toBe("user");
    expect(useChatStore.getState().streaming).toBe(true);

    // 2. Backend emits tool-use × 3 during the loop.
    const tools: ToolUseEvent[] = [
      { workspaceId, toolName: "list_files", toolInput: { path: "." }, result: "a\nb\nc" },
      { workspaceId, toolName: "read_file", toolInput: { path: "a" }, result: "// file a" },
      { workspaceId, toolName: "write_file", toolInput: { path: "b", content: "(123 chars)" }, result: "wrote" },
    ];
    for (const t of tools) emit("chat://tool-use", t);

    // After tool events: user + 3 tools = 4 messages.
    const beforeDone = useChatStore.getState().messages;
    expect(beforeDone).toHaveLength(4);
    expect(beforeDone.slice(1).every((m) => String(m.role) === "tool")).toBe(true);

    // 3. Backend emits final stream delta (the summary text), then done.
    emit("chat://stream", {
      workspaceId,
      delta: "Done. Built the thing.",
      done: false,
      inputTokens: null,
      outputTokens: null,
    } satisfies ChatStreamEvent);

    emit("chat://stream", {
      workspaceId,
      delta: "",
      done: true,
      inputTokens: 1000,
      outputTokens: 200,
    } satisfies ChatStreamEvent);

    // 4. EXPECTED: messages = user + 3 tools + assistant = 5.
    //    Bug: messages = user + assistant = 2 (tools dropped).
    const afterDone = useChatStore.getState().messages;

    // Role breakdown helps diagnose.
    const roleCounts = afterDone.reduce<Record<string, number>>((acc, m) => {
      const r = String(m.role);
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});

    expect(roleCounts).toEqual({ user: 1, tool: 3, assistant: 1 });
    expect(afterDone).toHaveLength(5);
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().streamBuffer).toBe("");
    // liveTools is cleared on done by design — that's fine.
    expect(useChatStore.getState().liveTools).toEqual([]);
  });

  it("survives Date.now() collisions between user msg and final assistant msg", () => {
    // Force Date.now to return the same value for the user msg and the
    // final assistant msg — this would collide React keys if both are
    // rendered as messages at the same key.
    const fixedNow = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => fixedNow;

    try {
      // Manually craft the sequence (skip send → no async timing).
      useChatStore.setState({
        messages: [
          {
            id: fixedNow,
            workspaceId: "ws-1",
            role: "user",
            content: "hi",
            model: null,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            createdAt: "now",
          },
        ],
        streaming: true,
        streamBuffer: "the answer",
        liveTools: [],
      });

      // Add a tool event (which uses Date.now() + Math.random() — float id).
      emit("chat://tool-use", {
        workspaceId: "ws-1",
        toolName: "read_file",
        toolInput: { path: "x" },
        result: "ok",
      });

      // Now done.
      emit("chat://stream", {
        workspaceId: "ws-1",
        delta: "",
        done: true,
        inputTokens: null,
        outputTokens: null,
      });

      const msgs = useChatStore.getState().messages;
      // Should still have user + tool + assistant.
      const roles = msgs.map((m) => String(m.role));
      expect(roles).toEqual(["user", "tool", "assistant"]);

      // Critical: user and assistant ids must not collide for React keys.
      const ids = msgs.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length); // ← will fail under Date.now collision
    } finally {
      Date.now = realNow;
    }
  });

  it("Date.now collision causes duplicate React keys in timeline", () => {
    // Simulate the exact id-assignment used by send() (user msg) and the
    // done handler (final assistant msg) when both call Date.now() in the
    // same millisecond — observable when the agentic loop is fast.
    const fixedNow = 1_700_000_000_000;
    const userMsgId = fixedNow;
    const assistantMsgId = fixedNow;

    useChatStore.setState({
      messages: [
        {
          id: userMsgId,
          workspaceId: "ws-1",
          role: "user",
          content: "hi",
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
        {
          id: 1700000000000.5, // tool msg id (float — Date.now + Math.random)
          workspaceId: "ws-1",
          role: "tool" as "user" | "assistant",
          content: JSON.stringify({ toolName: "read_file", toolInput: {}, result: "" }),
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
        {
          id: assistantMsgId,
          workspaceId: "ws-1",
          role: "assistant",
          content: "done",
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
      ],
    });

    // Compute React keys exactly as ChatView does.
    const timeline = useChatStore.getState().getTimeline();
    const keys = timeline.map((it) =>
      it.kind === "tool" ? `tool-${it.id}` : String(it.message.id),
    );
    // Bug: ["1700000000000", "tool-1700000000000.5", "1700000000000"] → duplicate.
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `Duplicate React keys found: ${JSON.stringify(keys)}`).toEqual([]);
  });

  it("getTimeline parses tool messages into tool items", () => {
    useChatStore.setState({
      messages: [
        {
          id: 1,
          workspaceId: "ws-1",
          role: "user",
          content: "hi",
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
        {
          id: 2,
          workspaceId: "ws-1",
          // Intentional: role is "tool" at runtime, but typed as user|assistant.
          role: "tool" as "user" | "assistant",
          content: JSON.stringify({
            toolName: "read_file",
            toolInput: { path: "x" },
            result: "ok",
          }),
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
        {
          id: 3,
          workspaceId: "ws-1",
          role: "assistant",
          content: "done",
          model: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          createdAt: "now",
        },
      ],
    });

    const timeline = useChatStore.getState().getTimeline();
    expect(timeline).toHaveLength(3);
    expect(timeline[0].kind).toBe("message");
    expect(timeline[1].kind).toBe("tool");
    expect(timeline[2].kind).toBe("message");
  });
});

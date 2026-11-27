/**
 * A Talk thread's generated title (#1137): after the first answer it replaces
 * the derived title, once, and never a title the user set.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, ChatThread } from "../lib/types";

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
    listChatMessages: vi.fn().mockResolvedValue([]),
    renameChatThread: vi.fn().mockResolvedValue(undefined),
    generateChatTitle: vi.fn(),
    listRunningThreads: vi.fn().mockResolvedValue([]),
  },
}));

const { useChatStore, _resetAutoTitlesForTests } = await import("./chatStore");
const { ipc } = await import("../lib/ipc");
const { deriveChatTitle } = await import("../lib/chatTitle");

const listMessages = vi.mocked(ipc.listChatMessages);
const generate = vi.mocked(ipc.generateChatTitle);
const rename = vi.mocked(ipc.renameChatThread);

let nextId = 1;
function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: nextId++,
    workspaceId: "ws-1",
    role,
    content,
    model: role === "assistant" ? "claude-opus-5-5" : null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: "2026-11-27T10:00:00Z",
  };
}

const ASK = "/ship-ticket https://acme.atlassian.net/browse/GUIDE-123";
const firstTurn = () => [msg("user", ASK), msg("assistant", "I waived the virtualenv findings.")];

function seed(title: string, messages: ChatMessage[]) {
  const thread: ChatThread = { id: "t1", workspaceId: "ws-1", title, createdAt: "", updatedAt: "" };
  useChatStore.setState({ threadsByWs: { "ws-1": [thread] }, activeThreadByWs: { "ws-1": "t1" } });
  listMessages.mockResolvedValue(messages);
}

const titleNow = () => useChatStore.getState().threadsByWs["ws-1"][0].title;

describe("generated thread titles", () => {
  beforeEach(() => {
    _resetAutoTitlesForTests();
    generate.mockReset();
    rename.mockClear();
    generate.mockResolvedValue({ text: "Waive virtualenv findings", model: "claude-haiku-5-5", costUsd: 0.0004 });
  });

  it("replaces the derived title when the first turn ends", async () => {
    const messages = firstTurn();
    seed(deriveChatTitle(messages), messages);
    handlers["chat://stream"]({ payload: { workspaceId: "ws-1", threadId: "t1", delta: "", done: true } });
    await vi.waitFor(() => expect(titleNow()).toBe("GUIDE-123 · Waive virtualenv findings"));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1", model: "claude-opus-5-5" }));
  });

  it("never replaces a title the user set", async () => {
    seed("Release checklist", firstTurn());
    await useChatStore.getState().autoTitleThread("ws-1", "t1");
    expect(generate).not.toHaveBeenCalled();
    expect(titleNow()).toBe("Release checklist");
  });

  it("keeps the derived title when no title comes back, and doesn't ask again on its own", async () => {
    const messages = firstTurn();
    const derived = deriveChatTitle(messages);
    seed(derived, messages);
    generate.mockResolvedValueOnce(null);
    await useChatStore.getState().autoTitleThread("ws-1", "t1");
    expect(titleNow()).toBe(derived);
    expect(rename).not.toHaveBeenCalled();
    await useChatStore.getState().autoTitleThread("ws-1", "t1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("runs only on the first turn", async () => {
    const messages = [...firstTurn(), msg("user", "and now?"), msg("assistant", "Done.")];
    seed(deriveChatTitle(messages), messages);
    await useChatStore.getState().autoTitleThread("ws-1", "t1");
    expect(generate).not.toHaveBeenCalled();
  });

  it("leaves a title renamed while the call ran", async () => {
    const messages = firstTurn();
    seed(deriveChatTitle(messages), messages);
    let answer: (v: { text: string; model: string; costUsd: number }) => void = () => {};
    generate.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const run = useChatStore.getState().autoTitleThread("ws-1", "t1");
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    await useChatStore.getState().renameThread("ws-1", "t1", "Mine");
    answer({ text: "Waive virtualenv findings", model: "claude-haiku-5-5", costUsd: 0 });
    await run;
    expect(titleNow()).toBe("Mine");
  });

  it("regenerates over any title on request", async () => {
    seed("Release checklist", firstTurn());
    expect(await useChatStore.getState().regenerateTitle("ws-1", "t1")).toBe(true);
    expect(titleNow()).toBe("GUIDE-123 · Waive virtualenv findings");
    generate.mockResolvedValueOnce(null);
    expect(await useChatStore.getState().regenerateTitle("ws-1", "t1")).toBe(false);
    expect(titleNow()).toBe("GUIDE-123 · Waive virtualenv findings");
  });
});

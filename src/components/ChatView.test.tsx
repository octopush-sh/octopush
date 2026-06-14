/**
 * Visual/render regression tests for ChatView.
 *
 * Sister to `chatStore.test.ts` which asserts state-level invariants.
 * THIS file asserts that the right pixels actually reach the DOM —
 * specifically that tool cards render when the chatStore has tool messages.
 *
 * Past bug history: tool cards have repeatedly disappeared visually even
 * when the state was correct. A unit test on the store alone can't catch
 * that. These tests render ChatView with React Testing Library and assert
 * specific DOM content.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

// ─── Mocks (must be set up BEFORE chatStore is imported) ──────────────
type EventHandler = (ev: { payload: unknown }) => void;
const handlers: Record<string, EventHandler> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: EventHandler) => {
    handlers[eventName] = handler;
    return Promise.resolve(() => {});
  }),
}));

const listChatMessagesMock = vi.fn().mockResolvedValue([]);
vi.mock("../lib/ipc", () => ({
  ipc: {
    sendChatMessage: vi.fn().mockResolvedValue(undefined),
    listChatMessages: listChatMessagesMock,
    listProviders: vi.fn().mockResolvedValue([]),
    revealInFinder: vi.fn(),
    openFileInSystem: vi.fn(),
    listBudgets: vi.fn().mockResolvedValue([]),
    currentSpend: vi.fn().mockResolvedValue({ costUsd: 0, tokens: 0 }),
    listWorkspaceFiles: vi.fn().mockResolvedValue([]),
    readFileChecked: vi.fn().mockResolvedValue({ kind: "text", content: "", size: 0, mtime: 0 }),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    listChatThreads: vi.fn().mockResolvedValue([
      { id: "t1", workspaceId: "ws-1", title: "Conversation", createdAt: "2026-05-17T09:00:00Z", updatedAt: "2026-05-17T09:00:00Z" },
    ]),
    createChatThread: vi.fn().mockResolvedValue(
      { id: "t1", workspaceId: "ws-1", title: "New conversation", createdAt: "2026-05-17T09:00:00Z", updatedAt: "2026-05-17T09:00:00Z" },
    ),
    renameChatThread: vi.fn().mockResolvedValue(undefined),
    deleteChatThread: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
  },
}));

// Dynamic imports AFTER mocks are wired.
const { useChatStore } = await import("../stores/chatStore");
const { ChatView } = await import("./ChatView");
const { useWorkspaceStore } = await import("../stores/workspaceStore");
const { useBudgetsStore, BUDGET_CAP_MSG } = await import("../stores/budgetsStore");

// ─── Helpers ──────────────────────────────────────────────────────────
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
  });
  useBudgetsStore.setState({
    budgets: [],
    spend: {},
    notifiedThresholds: new Set(),
    overrideActive: false,
  });
  // Workspace store must have an active id for the "notify on non-active
  // workspace" logic in the listener to no-op.
  useWorkspaceStore.setState({ activeId: "ws-1", workspaces: [], notifications: {}, loading: false });
}

function emit(eventName: string, payload: unknown) {
  const h = handlers[eventName];
  if (!h) throw new Error(`No handler registered for ${eventName}`);
  h({ payload });
}

// ─── Tests ────────────────────────────────────────────────────────────
describe("ChatView — renders tool cards in the DOM", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders a tool card when chatStore has a tool message (state-driven)", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1,
            workspaceId: "ws-1",
            role: "user",
            content: "Make a thing",
            model: null,
            inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:00Z",
          },
          {
            id: 2,
            workspaceId: "ws-1",
            role: "tool",
            content: JSON.stringify({
              toolName: "write_file",
              toolInput: { path: "index.html" },
              result: "wrote",
            }),
            model: null,
            inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:01Z",
          },
          {
            id: 3,
            workspaceId: "ws-1",
            role: "assistant",
            content: "Done.",
            model: "claude-sonnet-4-6",
            inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:02Z",
          },
        ],
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    // ToolCallCard renders the tool name uppercased and the path.
    expect(screen.getByText("WRITE")).toBeInTheDocument();
    expect(screen.getByText("index.html")).toBeInTheDocument();
  });

  it("renders tools through the full event flow (user → tool → assistant → done)", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    // Let mount-time loadHistory resolve before emitting; its async set
    // would otherwise wipe `messages` after our emits.
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 1, role: "user", content: "hi",
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:00Z",
      });
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 2, role: "tool",
        content: JSON.stringify({
          toolName: "read_file",
          toolInput: { path: "foo.txt" },
          result: "contents",
        }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:01Z",
      });
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 3, role: "assistant",
        content: "Done with that.", model: "claude-sonnet-4-6",
        inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:02Z",
      });
      emit("chat://stream", {
        workspaceId: "ws-1", delta: "", done: true,
        inputTokens: null, outputTokens: null,
      });
    });

    expect(screen.getByText("READ")).toBeInTheDocument();
    expect(screen.getByText("foo.txt")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText(/Done with that/i)).toBeInTheDocument();
  });

  it("renders historic tools after loadHistory returns DB-shaped rows", async () => {
    // Mirrors the EXACT production scenario the user reported: open a workspace
    // with persisted tool rows in SQLite. loadHistory fetches them via IPC.
    // Tool content uses the actual JSON shape seen in the user's DB
    // (toolInput.content was truncated to a placeholder string by an earlier
    // fix cycle — that's expected, but the path is intact).
    const historicRows = [
      {
        id: 1, workspaceId: "ws-1", role: "user",
        content: "Crea una landing page para un supermercado.",
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-16T10:00:00Z",
      },
      {
        id: 2, workspaceId: "ws-1", role: "tool",
        content: JSON.stringify({
          result: ".git",
          toolInput: { path: "." },
          toolName: "list_files",
        }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-16T10:00:01Z",
      },
      {
        id: 3, workspaceId: "ws-1", role: "tool",
        content: JSON.stringify({
          result: "Wrote 20584 bytes to index.html",
          toolInput: { content: "(20584 chars, written to disk)", path: "index.html" },
          toolName: "write_file",
        }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-16T10:00:02Z",
      },
      {
        id: 4, workspaceId: "ws-1", role: "tool",
        content: JSON.stringify({
          result: "Wrote 31679 bytes to styles.css",
          toolInput: { content: "(31679 chars, written to disk)", path: "styles.css" },
          toolName: "write_file",
        }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-16T10:00:03Z",
      },
      {
        id: 5, workspaceId: "ws-1", role: "assistant",
        content: "¡La landing page está lista!",
        model: "claude-sonnet-4-6",
        inputTokens: 1000, outputTokens: 200, costUsd: 0.01,
        createdAt: "2026-05-16T10:00:04Z",
      },
    ];
    listChatMessagesMock.mockResolvedValueOnce(historicRows);

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    // Wait for loadHistory to resolve and React to render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Tool cards must be visible after historical load.
    expect(screen.getByText("LIST")).toBeInTheDocument();
    expect(screen.getAllByText("WRITE")).toHaveLength(2);
    expect(screen.getByText("index.html")).toBeInTheDocument();
    expect(screen.getByText("styles.css")).toBeInTheDocument();
  });

  it("renders multiple tool cards in order between user and assistant", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1, workspaceId: "ws-1", role: "user", content: "Build it",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:00Z",
          },
          {
            id: 2, workspaceId: "ws-1",
            role: "tool",
            content: JSON.stringify({ toolName: "list_files", toolInput: { path: "." }, result: "" }),
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:01Z",
          },
          {
            id: 3, workspaceId: "ws-1",
            role: "tool",
            content: JSON.stringify({ toolName: "write_file", toolInput: { path: "a.ts" }, result: "" }),
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:02Z",
          },
          {
            id: 4, workspaceId: "ws-1",
            role: "tool",
            content: JSON.stringify({ toolName: "run_command", toolInput: { command: "npm test" }, result: "" }),
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:03Z",
          },
          {
            id: 5, workspaceId: "ws-1", role: "assistant",
            content: "All done.", model: "claude-sonnet-4-6",
            inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:04Z",
          },
        ],
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    // All three tool labels in the DOM.
    expect(screen.getByText("LIST")).toBeInTheDocument();
    expect(screen.getByText("WRITE")).toBeInTheDocument();
    expect(screen.getByText("RUN")).toBeInTheDocument();
  });

  it("renders persisted error rows as ErrorBlock in the timeline", async () => {
    // Simulates a workspace loaded after relaunch where a prior turn failed.
    // The DB returned a role="error" row alongside the user message.
    const historicRows = [
      {
        id: 1,
        workspaceId: "ws-1",
        role: "user",
        content: "Tell me a secret.",
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: "2026-05-17T10:00:00Z",
      },
      {
        id: 2,
        workspaceId: "ws-1",
        role: "error",
        content: "Anthropic API key not configured. Open Settings · Models & Providers.",
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: "2026-05-17T10:00:01Z",
      },
    ];
    listChatMessagesMock.mockResolvedValueOnce(historicRows);

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" onOpenSettings={() => {}} />);
    // Wait for loadHistory to resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The error content should appear in the DOM via ErrorBlock.
    expect(screen.getByText(/API key not configured/i)).toBeInTheDocument();
    // The "Something went wrong." heading from ErrorBlock.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    // Since content includes "API key" and onOpenSettings is provided, the button appears.
    expect(screen.getByText(/Configure API key/i)).toBeInTheDocument();
    // User message still renders.
    expect(screen.getByText("Tell me a secret.")).toBeInTheDocument();
  });

  it("renders a stopped marker as a quiet note, not a model bubble", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1, workspaceId: "ws-1", role: "user", content: "do a big thing",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:00Z",
          },
          {
            id: 2, workspaceId: "ws-1", role: "stopped", content: "Generation stopped.",
            model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 20, costUsd: 0.001,
            createdAt: "2026-05-17T10:00:01Z",
          },
        ],
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    const note = screen.getByText("Generation stopped.");
    expect(note).toBeInTheDocument();
    // It must render as the stopped note, never as an assistant bubble with a
    // model eyebrow.
    expect(note.closest('[data-role="stopped"]')).not.toBeNull();
    expect(note.closest('[data-role="assistant"]')).toBeNull();
  });

  it("survives the done event: tool cards remain after streaming finishes", async () => {
    // The exact sequence the user reported as broken — user message,
    // tool executions, final assistant, done event. Tools must stay visible.
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 1, role: "user",
        content: "Crea una landing page",
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:00Z",
      });
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 2, role: "tool",
        content: JSON.stringify({ toolName: "write_file", toolInput: { path: "index.html" }, result: "ok" }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:01Z",
      });
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 3, role: "tool",
        content: JSON.stringify({ toolName: "write_file", toolInput: { path: "styles.css" }, result: "ok" }),
        model: null, inputTokens: null, outputTokens: null, costUsd: null,
        createdAt: "2026-05-17T10:00:02Z",
      });
    });

    // Pre-done: tool cards visible.
    expect(screen.getByText("index.html")).toBeInTheDocument();
    expect(screen.getByText("styles.css")).toBeInTheDocument();

    await act(async () => {
      // Stream delta for the final text (no DOM assertion needed in between).
      emit("chat://stream", {
        workspaceId: "ws-1", delta: "La landing page está lista.", done: false,
        inputTokens: null, outputTokens: null,
      });
      // Assistant message arrives via the same channel.
      emit("chat://message-added", {
        workspaceId: "ws-1", id: 4, role: "assistant",
        content: "La landing page está lista.",
        model: "claude-sonnet-4-6",
        inputTokens: 1000, outputTokens: 200, costUsd: 0.01,
        createdAt: "2026-05-17T10:00:03Z",
      });
      // Done event (metadata only — no message append).
      emit("chat://stream", {
        workspaceId: "ws-1", delta: "", done: true,
        inputTokens: 1000, outputTokens: 200,
      });
    });

    // CRITICAL: tool cards must STILL be in the DOM after the done event.
    expect(screen.getByText("index.html")).toBeInTheDocument();
    expect(screen.getByText("styles.css")).toBeInTheDocument();
    expect(screen.getAllByText("WRITE")).toHaveLength(2);
    expect(screen.getByText(/landing page está lista/i)).toBeInTheDocument();
  });
});

// ─── Arrow-key prompt history ────────────────────────────────────────────────

describe("ChatView — arrow-key prompt history", () => {
  beforeEach(() => {
    resetStore();
  });

  function getTextarea() {
    return screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
  }

  // Helper: type text, press Enter, then emit the `done` stream event so
  // the chatStore resets streaming=false (otherwise subsequent sends are blocked).
  async function sendMessage(ta: HTMLTextAreaElement, text: string) {
    await act(async () => {
      fireEvent.change(ta, { target: { value: text } });
      fireEvent.keyDown(ta, { key: "Enter" });
      // Let the `send` async fn run and set streaming=true.
      await Promise.resolve();
    });
    // Reset streaming so the next send isn't blocked.
    await act(async () => {
      emit("chat://stream", {
        workspaceId: "ws-1",
        delta: "",
        done: true,
        inputTokens: null,
        outputTokens: null,
      });
    });
  }

  it("input clears after sending a message", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(ta.value).toBe("hello");

    await sendMessage(ta, "hello");
    expect(ta.value).toBe("");
  });

  it("ArrowUp on empty input recalls the last sent message", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();

    await sendMessage(ta, "hello");
    expect(ta.value).toBe("");

    // ArrowUp should recall "hello".
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("hello");
  });

  it("ArrowUp cycles through multiple history entries", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();

    await sendMessage(ta, "first");
    await sendMessage(ta, "second");

    // First ArrowUp → "second" (most recent).
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("second");

    // Second ArrowUp → "first".
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("first");
  });

  it("ArrowDown navigates forward through history and back to empty", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();

    await sendMessage(ta, "alpha");
    await sendMessage(ta, "beta");

    // Navigate back twice.
    fireEvent.keyDown(ta, { key: "ArrowUp" }); // → "beta"
    fireEvent.keyDown(ta, { key: "ArrowUp" }); // → "alpha"

    // Now come forward.
    fireEvent.keyDown(ta, { key: "ArrowDown" }); // → "beta"
    expect(ta.value).toBe("beta");

    fireEvent.keyDown(ta, { key: "ArrowDown" }); // → ""
    expect(ta.value).toBe("");
  });

  it("Escape while navigating clears input and exits history mode", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();

    await sendMessage(ta, "escape-me");

    fireEvent.keyDown(ta, { key: "ArrowUp" }); // → "escape-me"
    expect(ta.value).toBe("escape-me");

    fireEvent.keyDown(ta, { key: "Escape" });
    expect(ta.value).toBe("");

    // ArrowDown should do nothing now (not navigating).
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(ta.value).toBe("");
  });

  it("does not deduplicate non-consecutive identical prompts", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });

    const ta = getTextarea();

    // Send "a", "b", "a" — "b" breaks the run so "a" appears at idx 0 and 2.
    await sendMessage(ta, "a");
    await sendMessage(ta, "b");
    await sendMessage(ta, "a");

    // History is ["a", "b", "a"]. ArrowUp x3 should yield "a" → "b" → "a".
    fireEvent.keyDown(ta, { key: "ArrowUp" }); expect(ta.value).toBe("a");
    fireEvent.keyDown(ta, { key: "ArrowUp" }); expect(ta.value).toBe("b");
    fireEvent.keyDown(ta, { key: "ArrowUp" }); expect(ta.value).toBe("a");
  });
});

// ─── Budget error & override ──────────────────────────────────────────
describe("ChatView — budget error and override", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows BudgetErrorBlock with Override button when error is budget cap message", () => {
    useChatStore.setState({
      errorByWs: { "ws-1": BUDGET_CAP_MSG },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    expect(screen.getByText(/Budget cap reached/i)).toBeTruthy();
    expect(screen.getByText(/Override for this turn/i)).toBeTruthy();
  });

  it("Override button enables override and clears error", async () => {
    useChatStore.setState({
      errorByWs: { "ws-1": BUDGET_CAP_MSG },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    const overrideBtn = screen.getByText(/Override for this turn/i);
    await act(async () => {
      fireEvent.click(overrideBtn);
    });

    // Error is cleared
    expect(useChatStore.getState().errorByWs["ws-1"]).toBeNull();
    // Override is armed
    expect(useBudgetsStore.getState().overrideActive).toBe(true);
  });

  it("does NOT show BudgetErrorBlock for generic errors", () => {
    useChatStore.setState({
      errorByWs: { "ws-1": "Something else went wrong" },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    expect(screen.queryByText(/Budget cap reached/i)).toBeNull();
    expect(screen.queryByText(/Override for this turn/i)).toBeNull();
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
  });
});

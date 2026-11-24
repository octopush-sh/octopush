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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";

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
    getSettings: vi.fn().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} }),
    revealInFinder: vi.fn(),
    openFileInSystem: vi.fn(),
    listBudgets: vi.fn().mockResolvedValue([]),
    currentSpend: vi.fn().mockResolvedValue({ costUsd: 0, tokens: 0 }),
    listWorkspaceFiles: vi.fn().mockResolvedValue([]),
    readFileChecked: vi.fn().mockResolvedValue({ kind: "text", content: "", size: 0, mtime: 0 }),
    readFileLines: vi.fn().mockResolvedValue({ kind: "text", content: "", start: 1, end: 1, total: 1, cut: false }),
    secretScanText: vi.fn().mockResolvedValue(null),
    getGitDiff: vi.fn().mockResolvedValue(""),
    getStagedDiff: vi.fn().mockResolvedValue(""),
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
    readAttachment: vi.fn().mockResolvedValue({ mediaType: "image/png", data: "", name: "x.png" }),
  },
}));

// Dynamic imports AFTER mocks are wired.
const { useChatStore } = await import("../stores/chatStore");
const { ChatView } = await import("./ChatView");
const { useWorkspaceStore } = await import("../stores/workspaceStore");
const { useBudgetsStore, BUDGET_CAP_MSG } = await import("../stores/budgetsStore");
const { ipc: ipcMock } = await import("../lib/ipc");

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
    attachmentsByWs: {},
    composerSeedByWs: {},
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

  it("marks a streaming partial as distinct from a finished turn (pinned Player says Writing…)", () => {
    useChatStore.setState({
      messagesByWs: { "ws-1": [] },
      streamingByWs: { "ws-1": true },
      streamBufferByWs: { "ws-1": "Working on it" },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    expect(screen.getByText(/Working on it/)).toBeInTheDocument();
    // The scroll-away "Generating" dot was replaced by the pinned OctoStatus
    // figure (spec 2026-07-19 §4): text flowing → "Writing…".
    expect(screen.getByText("Writing…")).toBeInTheDocument();
  });

  it("exposes Edit on user turns and Regenerate on assistant turns", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          { id: 1, workspaceId: "ws-1", role: "user", content: "do a thing",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:00Z" },
          { id: 2, workspaceId: "ws-1", role: "assistant", content: "did it",
            model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:01Z" },
        ],
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    expect(screen.getByLabelText("Edit & resend")).toBeInTheDocument();
    expect(screen.getByLabelText("Regenerate")).toBeInTheDocument();
  });

  it("composer exposes a help popover documenting the @/ / /$ input modes", () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    const help = screen.getByLabelText("Shortcuts & input modes");
    expect(help).toBeInTheDocument();
    fireEvent.click(help);
    expect(screen.getByText(/Reference a file/i)).toBeInTheDocument();
    expect(screen.getByText(/Run a command in the shared shell/i)).toBeInTheDocument();
  });

  it("offers Regenerate/Edit only on the latest exchange, not on older turns", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          { id: 1, workspaceId: "ws-1", role: "user", content: "old question",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:00Z" },
          { id: 2, workspaceId: "ws-1", role: "assistant", content: "old answer",
            model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:01Z" },
          { id: 3, workspaceId: "ws-1", role: "user", content: "new question",
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:02Z" },
          { id: 4, workspaceId: "ws-1", role: "assistant", content: "new answer",
            model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-06-20T10:00:03Z" },
        ],
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    // Exactly one of each action — on the latest user/assistant turns only.
    expect(screen.getAllByLabelText("Edit & resend")).toHaveLength(1);
    expect(screen.getAllByLabelText("Regenerate")).toHaveLength(1);
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

  it("run_command card exposes a Send-to-terminal action wired to onRunInTerminal", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1, workspaceId: "ws-1", role: "tool",
            content: JSON.stringify({ toolName: "run_command", toolInput: { command: "npm test" }, result: "" }),
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:00Z",
          },
        ],
      },
      streamingByWs: { "ws-1": false },
    });
    const onRunInTerminal = vi.fn();
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" onRunInTerminal={onRunInTerminal} />);
    // An icon with a title and an accessible name (shown on row hover/focus).
    fireEvent.click(screen.getByRole("button", { name: "Send to terminal" }));
    expect(onRunInTerminal).toHaveBeenCalledWith("npm test");
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

// ─── Turn structure: a section of articles, the work block ─────────────────

describe("ChatView — turns read apart in a long thread", () => {
  beforeEach(() => {
    resetStore();
  });

  const row = (id: number, role: string, content: string, model: string | null = null) => ({
    id, workspaceId: "ws-1", role, content, model,
    inputTokens: null, outputTokens: null, costUsd: null,
    createdAt: "2026-05-17T10:00:00Z",
  });
  const toolRow = (id: number, toolName: string, toolInput: Record<string, unknown>) =>
    row(id, "tool", JSON.stringify({ toolName, toolInput, result: "" }));

  it("is a section of articles: the ask, the work (one hairline), the answer", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          row(1, "user", "Why a 500?"),
          row(2, "assistant_tool_use", "Let me find where the limiter talks to Redis."),
          toolRow(3, "grep", { pattern: "RateLimiter" }),
          toolRow(4, "read_file", { path: "src/lib/redis.ts" }),
          row(5, "assistant", "The store call has no catch. Here is the fix.", "claude-opus-4-7"),
        ] as never,
      },
      streamingByWs: { "ws-1": false },
    });

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    // A labelled section, not role="feed": the thread doesn't implement the
    // feed pattern's keyboard model, so it doesn't claim it.
    expect(screen.queryByRole("feed")).toBeNull();
    const thread = screen.getByRole("region", { name: "Conversation" });
    const articles = within(thread).getAllByRole("article");
    expect(articles.map((a) => a.getAttribute("data-role"))).toEqual(["user", "work", "assistant"]);
    // The narration and both calls are inside the one work article.
    const work = articles[1];
    expect(within(work).getByText(/Let me find where the limiter/)).toBeInTheDocument();
    expect(within(work).getByRole("group", { name: "2 tool calls" })).toBeInTheDocument();
    expect(work).toHaveAttribute("aria-label", "Work, 2 tool calls");
  });

  it("puts a user turn's actions inside the ask, and an answer's inside it after its text", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [row(1, "user", "do a thing"), row(2, "assistant", "did it", "claude-sonnet-4-6")] as never,
      },
      streamingByWs: { "ws-1": false },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);

    const ask = document.querySelector('[data-role="user"]')!;
    expect(within(ask as HTMLElement).getByLabelText("Edit & resend")).toBeInTheDocument();
    // An answer's actions are inside its article, after its text.
    const answer = document.querySelector('[data-role="assistant"]')!;
    const regenerate = screen.getByLabelText("Regenerate");
    expect(answer.contains(regenerate)).toBe(true);
    const text = within(answer as HTMLElement).getByText("did it");
    expect(text.compareDocumentPosition(regenerate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hangs a running call on the work hairline as a ledger row, continuing the turn's block", () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [row(1, "user", "Run the tests"), row(2, "assistant_tool_use", "Running the suite.")] as never,
      },
      streamingByWs: { "ws-1": true },
      liveToolsByWs: {
        "ws-1": [{ callId: "c1", toolName: "run_command", toolInput: { command: "npm test" }, startedAt: new Date().toISOString(), done: false, ok: false, durationMs: null }],
      },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    const live = document.querySelector('[data-role="live-work"]') as HTMLElement;
    expect(live.className).toContain("border-l");
    // The turn's work block is the last thing on screen, so the live rows
    // continue its line instead of starting a new one.
    expect(live.className).toContain("-mt-[22px]");
    const runRow = within(live).getByText("npm test").parentElement!;
    expect(runRow.className).not.toContain("border");
    expect(within(live).getByText(/running ·/)).toBeInTheDocument();
  });

  it("copies exactly what the user sent, without the turn's header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useChatStore.setState({
      messagesByWs: { "ws-1": [row(1, "user", "line one\n  line two")] as never },
      streamingByWs: { "ws-1": false },
    });
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    fireEvent.click(screen.getByLabelText("Copy message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("line one\n  line two"));
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

  it("takes a fork's seeded draft into the textarea, once (#958)", async () => {
    useChatStore.setState({ composerSeedByWs: { "ws-1": "Make it stream" } });
    const { unmount } = render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });
    expect(getTextarea().value).toBe("Make it stream");
    expect(useChatStore.getState().composerSeedByWs["ws-1"]).toBeNull();
    // Opened again, the composer doesn't put it back.
    unmount();
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });
    expect(getTextarea().value).toBe("");
  });

  it("puts a fork's seed after a half-typed message instead of replacing it (#958)", async () => {
    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    await act(async () => { await Promise.resolve(); });
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: "half a thought " } });
    await act(async () => {
      useChatStore.setState({ composerSeedByWs: { "ws-1": "Make it stream" } });
      await Promise.resolve();
    });
    expect(getTextarea().value).toBe("half a thought\n\nMake it stream");
    expect(useChatStore.getState().composerSeedByWs["ws-1"]).toBeNull();
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

describe("ChatView — /skill menu and inline highlight", () => {
  const skills = [
    { name: "release", description: "Cut a release", source: "project" },
    { name: "code-review", description: "Review the diff", source: "project" },
  ];
  beforeEach(() => {
    resetStore();
    vi.mocked(ipcMock.listSkills).mockResolvedValue(skills);
  });

  function getTextarea() {
    return screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
  }

  /** Type `value` with the caret at its end. */
  function type(ta: HTMLTextAreaElement, value: string) {
    fireEvent.change(ta, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  }

  it("opens mid-sentence on a matching /query, inserts the token on Enter, and paints it inline", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    type(ta, "please /rel");
    const menu = await screen.findByRole("listbox", { name: "Skills" });
    expect(menu).toHaveTextContent("release");
    expect(menu).not.toHaveTextContent("code-review");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("please /release ");
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
    // The token is painted in the sentence, not pinned anywhere.
    expect(screen.getAllByTestId("skill-highlight").map((m) => m.textContent)).toEqual(["/release"]);
    type(ta, "please /release and /code-review");
    expect(screen.getAllByTestId("skill-highlight").map((m) => m.textContent)).toEqual(["/release", "/code-review"]);
  });

  it("stays closed for a query no skill matches, a path, and a $ command line; Escape dismisses it", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    type(ta, "see /etc");
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
    type(ta, "see src/rel");
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
    type(ta, "$ ls /rel");
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
    type(ta, "run /rel");
    expect(await screen.findByRole("listbox", { name: "Skills" })).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
  });

  it("sends the tokens as plain text — no skill field, nothing pinned for the next message", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    await act(async () => {
      type(ta, "/release this");
      fireEvent.keyDown(ta, { key: "Enter" });
      await Promise.resolve();
    });
    const req = vi.mocked(ipcMock.sendChatMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.userMessage).toBe("/release this");
    expect("skill" in req).toBe(false);
    expect(ta.value).toBe("");
    expect(screen.queryByTestId("skill-highlight")).toBeNull();
  });
});

describe("ChatView — context mentions (#962)", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(ipcMock.listWorkspaceFiles).mockResolvedValue(["src/a.ts", "src/lib/b.ts"]);
    vi.mocked(ipcMock.readFileChecked).mockResolvedValue({
      kind: "text", content: "1\n2\n3\n4\n5", size: 9, mtime: 0,
    });
    vi.mocked(ipcMock.readFileLines).mockResolvedValue({
      kind: "text", content: "2\n3", start: 2, end: 3, total: 5, cut: false,
    });
    vi.mocked(ipcMock.secretScanText).mockResolvedValue(null);
  });

  function getTextarea() {
    return screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
  }

  it("shows a removable chip with its token estimate for a line range, and removing it edits the draft", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: "why @src/a.ts#L2-3 fails" } });
    const chip = await screen.findByText("a.ts#L2-3");
    await waitFor(() =>
      expect(chip.closest("[data-tour='talk-context-chip']")?.getAttribute("title")).toMatch(/≈ \d+ tokens/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove @src/a.ts#L2-3" }));
    expect(ta.value).toBe("why fails");
    expect(screen.queryByText("a.ts#L2-3")).toBeNull();
  });

  it("sends only the range's lines", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    await act(async () => {
      fireEvent.change(ta, { target: { value: "explain @src/a.ts#L2-3" } });
    });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    await waitFor(() => expect(ipcMock.sendChatMessage).toHaveBeenCalled());
    const req = vi.mocked(ipcMock.sendChatMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.userMessage).toBe("explain @src/a.ts#L2-3\n\nsrc/a.ts · lines 2–3 of 5\n```\n2\n3\n```");
  });

  it("estimates @diff again in the next draft once the diff changed", async () => {
    vi.mocked(ipcMock.getGitDiff).mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n+a\n");
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    const chipTitle = () =>
      document.querySelector("[data-tour='talk-context-chip']")?.getAttribute("title") ?? "";
    fireEvent.change(ta, { target: { value: "review @diff today" } });
    await waitFor(() => expect(chipTitle()).toMatch(/≈ \d+ tokens$/));
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    await waitFor(() => expect(ipcMock.sendChatMessage).toHaveBeenCalled());
    vi.mocked(ipcMock.getGitDiff).mockResolvedValue(`diff --git a/src/a.ts b/src/a.ts\n+${"x".repeat(8000)}\n`);
    fireEvent.change(ta, { target: { value: "and @diff again" } });
    await waitFor(() => expect(chipTitle()).toMatch(/≈ 2k tokens$/));
    vi.mocked(ipcMock.getGitDiff).mockResolvedValue("");
  });

  it("appends a range handed over from Review to the draft", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: "look at" } });
    act(() => useChatStore.getState().queueDraftInsert("ws-1", "@src/a.ts#L4-5 "));
    expect(ta.value).toBe("look at @src/a.ts#L4-5 ");
    expect(useChatStore.getState().draftInsertByWs["ws-1"]).toBeUndefined();
    expect(await screen.findByText("a.ts#L4-5")).toBeInTheDocument();
  });

  it("offers folders and the diff in the @ popover, and closes it while a range is typed", async () => {
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    const list = await screen.findByRole("listbox", { name: "Worktree files" });
    expect(list.textContent).toContain("Add context");
    expect(list.textContent).toContain("diff");
    expect(list.textContent).toContain("src/");
    fireEvent.change(ta, { target: { value: "@src/a.ts#L1", selectionStart: 12, selectionEnd: 12 } });
    expect(screen.queryByRole("listbox", { name: "Worktree files" })).toBeNull();
  });
});

describe("ChatView — context guard and limits (#1046)", () => {
  const finding = { file: ".env", line: 1, rule: "env-credential", kind: "credential in a .env file (DB_PASSWORD)", yours: false };
  beforeEach(() => {
    resetStore();
    vi.mocked(ipcMock.sendChatMessage).mockClear();
    // The diff is scanned per file, by the file's path.
    vi.mocked(ipcMock.getGitDiff)
      .mockClear()
      .mockResolvedValue("diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+t\n");
    vi.mocked(ipcMock.listWorkspaceFiles).mockResolvedValue(["src/a.ts", "src/lib/b.ts"]);
    vi.mocked(ipcMock.readFileLines).mockResolvedValue({
      kind: "text", content: "2\n3", start: 2, end: 3, total: 5, cut: false,
    });
    vi.mocked(ipcMock.secretScanText).mockImplementation(async (blocks) =>
      blocks.some((b) => b.label === ".env" && b.wholeFile)
        ? { findings: [finding], total: 1, partial: false }
        : { findings: [], total: 0, partial: false },
    );
  });
  afterEach(() => {
    vi.mocked(ipcMock.getGitDiff).mockResolvedValue("");
    vi.mocked(ipcMock.secretScanText).mockResolvedValue(null);
  });

  async function sendDraft(value: string) {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value } });
    });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    return view;
  }

  it("asks before sending a block that holds a possible secret, and leaves it out", async () => {
    await sendDraft("check @src/a.ts#L2-3 and @diff now");
    expect(
      await screen.findByText("This message attaches what looks like a credential in a .env file (DB_PASSWORD) in .env:1."),
    ).toBeInTheDocument();
    expect(ipcMock.sendChatMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Leave it out" }));
    await waitFor(() => expect(ipcMock.sendChatMessage).toHaveBeenCalled());
    const req = vi.mocked(ipcMock.sendChatMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.userMessage).toBe(
      "check @src/a.ts#L2-3 and @diff now\n\nsrc/a.ts · lines 2–3 of 5\n```\n2\n3\n```\n\ndiff _(not included: possible secret)_",
    );
  });

  it("sends the block for this one message when confirmed", async () => {
    await sendDraft("check @diff now");
    fireEvent.click(await screen.findByRole("button", { name: "Send regardless" }));
    await waitFor(() => expect(ipcMock.sendChatMessage).toHaveBeenCalled());
    const req = vi.mocked(ipcMock.sendChatMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.userMessage).toContain("+t");
  });

  it("asks before sending a block the scan couldn't check, and leaves it out by default", async () => {
    vi.mocked(ipcMock.secretScanText).mockRejectedValue(new Error("secret scan stopped"));
    await sendDraft("check @diff now");
    expect(await screen.findByText("This message's @diff couldn't be checked.")).toBeInTheDocument();
    expect(screen.queryByText(/16 MB/)).toBeNull();
    expect(ipcMock.sendChatMessage).not.toHaveBeenCalled();
    const leaveOut = screen.getByRole("button", { name: "Leave it out" });
    expect(leaveOut).toHaveFocus();
    fireEvent.click(leaveOut);
    await waitFor(() => expect(ipcMock.sendChatMessage).toHaveBeenCalled());
    const req = vi.mocked(ipcMock.sendChatMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(req.userMessage).toBe("check @diff now\n\ndiff _(not included: couldn't be checked for secrets)_");
  });

  it("sends nothing on Escape and gives the draft back", async () => {
    await sendDraft("check @diff now");
    await screen.findByRole("button", { name: "Leave it out" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Leave it out" })).toBeNull());
    expect(ipcMock.sendChatMessage).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement).value).toBe("check @diff now");
  });

  it("keeps a held message's draft in its workspace when the workspace changes", async () => {
    const view = await sendDraft("check @diff now");
    await screen.findByRole("button", { name: "Leave it out" });
    await act(async () => {
      view.rerender(<ChatView workspaceId="ws-2" workspacePath="/tmp2" />);
    });
    expect(screen.queryByRole("button", { name: "Leave it out" })).toBeNull();
    expect(ipcMock.sendChatMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().composerSeedByWs["ws-1"]).toBe("check @diff now");
    await act(async () => {
      view.rerender(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    expect((screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement).value).toBe("check @diff now");
  });

  it("attaches at most ten mentions and says so", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    vi.mocked(ipcMock.listWorkspaceFiles).mockResolvedValue(many);
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: many.map((f) => `@${f}`).join(" ") } });
    expect(await screen.findByText("10 at most · 2 more sent as text")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove @/ })).toHaveLength(10);
  });

  it("reads the diff once for its estimate while typing goes on", async () => {
    let answer: (v: string) => void = () => {};
    vi.mocked(ipcMock.getGitDiff).mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await act(async () => {
      render(<ChatView workspaceId="ws-1" workspacePath="/tmp" />);
    });
    const ta = screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "review @diff" } });
    await waitFor(() => expect(ipcMock.getGitDiff).toHaveBeenCalledTimes(1));
    for (const value of ["review @diff t", "review @diff to", "review @diff tod"]) {
      fireEvent.change(ta, { target: { value } });
      await act(() => new Promise((r) => setTimeout(r, 300)));
    }
    expect(ipcMock.getGitDiff).toHaveBeenCalledTimes(1);
    await act(async () => answer("diff --git a/src/a.ts b/src/a.ts\n+a\n"));
    await waitFor(() =>
      expect(document.querySelector("[data-tour='talk-context-chip']")?.getAttribute("title")).toMatch(/≈ \d+ tokens$/),
    );
  });
});

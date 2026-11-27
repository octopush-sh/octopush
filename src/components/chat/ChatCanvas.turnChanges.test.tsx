/**
 * #1152 — each finished Talk turn that changed files ends with its changes
 * row, under the answer; a turn without a checkpoint, or the turn in
 * flight, shows none.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));

const THREAD = { id: "t1", workspaceId: "ws-1", title: "Parser", createdAt: "2026-11-20T09:00:00Z", updatedAt: "2026-11-20T09:00:00Z" };

function row(id: number, role: "user" | "assistant", content: string) {
  return { id, workspaceId: "ws-1", role, content, model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: `2026-11-20T10:00:0${id}Z` };
}
const ROWS = [row(1, "user", "Add a parser"), row(2, "assistant", "Done."), row(3, "user", "Make it stream"), row(4, "assistant", "Streaming now.")];

vi.mock("../../lib/ipc", () => ({
  ipc: {
    listChatThreads: vi.fn(),
    createChatThread: vi.fn(),
    listChatMessages: vi.fn(),
    listTalkCheckpoints: vi.fn(),
    talkTurnChanges: vi.fn(),
  },
}));

const { ipc } = await import("../../lib/ipc");
const { useChatStore } = await import("../../stores/chatStore");
const { ChatCanvas } = await import("./ChatCanvas");

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.listChatThreads).mockResolvedValue([THREAD]);
  vi.mocked(ipc.listChatMessages).mockResolvedValue(ROWS);
  // Only the second turn took a checkpoint.
  vi.mocked(ipc.listTalkCheckpoints).mockResolvedValue({ turns: [3], skipped: [], canUndo: false });
  vi.mocked(ipc.talkTurnChanges).mockResolvedValue([
    { path: "src/parser.ts", status: "modified", added: 12, removed: 3 },
    { path: "src/stream.ts", status: "added", added: 40, removed: 0 },
  ]);
  useChatStore.setState({
    messagesByWs: {},
    threadsByWs: {},
    activeThreadByWs: {},
    streamingByWs: {},
    streamingThreadsByWs: {},
    composerSeedByWs: {},
  });
});

describe("Talk turn changes row (#1152)", () => {
  it("ends the turn that took a checkpoint with its changes, under its answer", async () => {
    render(<ChatCanvas workspaceId="ws-1" workspacePath="/repo" />);
    await flush();
    const rows = screen.getAllByTestId("talk-turn-changes");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("2 files changed · +52 −3");
    expect(ipc.talkTurnChanges).toHaveBeenCalledTimes(1);
    expect(ipc.talkTurnChanges).toHaveBeenCalledWith("t1", 3);
    // After the answer, not between the ask and it.
    const answer = screen.getByText("Streaming now.");
    expect(answer.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no row while the turn is still running", async () => {
    render(<ChatCanvas workspaceId="ws-1" workspacePath="/repo" />);
    await flush();
    expect(screen.getByTestId("talk-turn-changes")).toBeInTheDocument();
    act(() => useChatStore.setState({ streamingByWs: { "ws-1": true } }));
    expect(screen.queryByTestId("talk-turn-changes")).toBeNull();
  });

  it("shows no row when the turn changed nothing", async () => {
    vi.mocked(ipc.talkTurnChanges).mockResolvedValue([]);
    render(<ChatCanvas workspaceId="ws-1" workspacePath="/repo" />);
    await flush();
    expect(ipc.talkTurnChanges).toHaveBeenCalledWith("t1", 3);
    expect(screen.queryByTestId("talk-turn-changes")).toBeNull();
  });
});

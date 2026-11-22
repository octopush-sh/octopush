/**
 * #958 — Talk: rewind files to a turn, or fork the conversation from it.
 * The hover actions on a user turn, the confirm that shows what will change
 * (outside-Talk edits flagged) before anything is written, the undo, and the
 * fork that opens a new thread with the turn as its draft.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const toasts: Array<{ title: string; body?: string; action?: { label: string; onClick: () => void } }> = [];
vi.mock("../Toasts", () => ({
  pushToast: (t: (typeof toasts)[number]) => toasts.push(t),
}));

const THREAD = { id: "t1", workspaceId: "ws-1", title: "Parser", createdAt: "2026-11-20T09:00:00Z", updatedAt: "2026-11-20T09:00:00Z" };
const FORK = { ...THREAD, id: "t2", title: "Parser · fork" };

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
    previewTalkRewind: vi.fn(),
    rewindTalkFiles: vi.fn(),
    undoTalkRewind: vi.fn(),
    forkChatThread: vi.fn(),
  },
}));

const { ipc } = await import("../../lib/ipc");
const { useChatStore } = await import("../../stores/chatStore");
const { ChatCanvas } = await import("./ChatCanvas");
const { rewindHeadline, outsideNote, rewindError } = await import("../../lib/talkRewind");

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function mount() {
  render(<ChatCanvas workspaceId="ws-1" workspacePath="/repo" />);
  await flush();
}

beforeEach(() => {
  toasts.length = 0;
  vi.mocked(ipc.listChatThreads).mockResolvedValue([THREAD]);
  vi.mocked(ipc.listChatMessages).mockResolvedValue(ROWS);
  // Only the second turn took a checkpoint (the first ran before checkpoints).
  vi.mocked(ipc.listTalkCheckpoints).mockResolvedValue([3]);
  vi.mocked(ipc.previewTalkRewind).mockResolvedValue({
    messageId: 3,
    current: "abc1234",
    changes: [
      { path: "src/parser.ts", kind: "reverted", outsideTalk: false },
      { path: "src/stream.ts", kind: "removed", outsideTalk: false },
      { path: "README.md", kind: "reverted", outsideTalk: true },
    ],
  });
  vi.mocked(ipc.rewindTalkFiles).mockResolvedValue(3);
  vi.mocked(ipc.undoTalkRewind).mockResolvedValue(3);
  vi.mocked(ipc.forkChatThread).mockResolvedValue({ thread: FORK, draft: "Make it stream" });
  useChatStore.setState({
    messagesByWs: {},
    threadsByWs: {},
    activeThreadByWs: {},
    streamingByWs: {},
    streamingThreadByWs: {},
    composerSeedByWs: {},
  });
});

describe("rewind wording", () => {
  it("says how many files go back and flags edits made outside the conversation", () => {
    expect(rewindHeadline([])).toBe("The files already match this turn.");
    expect(rewindHeadline([{ path: "a", kind: "reverted", outsideTalk: false }])).toBe("1 file goes back to before this turn.");
    expect(outsideNote([{ path: "a", kind: "reverted", outsideTalk: false }])).toBeNull();
    expect(outsideNote([{ path: "a", kind: "reverted", outsideTalk: true }])).toBe(
      "1 of them was changed outside this conversation since; the rewind undoes that too.",
    );
    expect(rewindError("other: The files changed since the preview.")).toBe("The files changed since the preview.");
  });
});

describe("Talk rewind & fork (#958)", () => {
  it("offers Rewind only on a turn with a checkpoint, Fork on every turn you sent", async () => {
    await mount();
    expect(screen.getAllByRole("button", { name: "Rewind files to here" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Fork from here" })).toHaveLength(2);
    expect(ipc.listTalkCheckpoints).toHaveBeenCalledWith("/repo", "t1");
  });

  it("shows what will change before writing, then rewinds the previewed tree and offers the undo", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(ipc.previewTalkRewind).toHaveBeenCalledWith("/repo", "t1", 3);
    expect(screen.getByText("3 files go back to before this turn.")).toBeInTheDocument();
    expect(screen.getByText("src/stream.ts")).toBeInTheDocument();
    expect(screen.getByText("changed outside")).toBeInTheDocument();
    expect(screen.getByText(/1 of them was changed outside this conversation/)).toBeInTheDocument();
    expect(ipc.rewindTalkFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    expect(ipc.rewindTalkFiles).toHaveBeenCalledWith("ws-1", "/repo", "t1", 3, "abc1234");
    expect(ipc.forkChatThread).not.toHaveBeenCalled();
    expect(screen.queryByText("3 files go back to before this turn.")).not.toBeInTheDocument();
    const toast = toasts.at(-1)!;
    expect(toast.title).toBe("Rewound 3 files.");
    expect(toast.action?.label).toBe("Undo the rewind");

    toast.action!.onClick();
    await flush();
    expect(ipc.undoTalkRewind).toHaveBeenCalledWith("ws-1", "/repo", "t1");
    expect(toasts.at(-1)!.title).toBe("The files are back as they were.");
  });

  it("keeps the dialog open with the reason when the rewind is refused", async () => {
    vi.mocked(ipc.rewindTalkFiles).mockRejectedValue("other: The files changed since the preview. Look at the rewind again.");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    expect(screen.getByText("The files changed since the preview. Look at the rewind again.")).toBeInTheDocument();
    expect(toasts).toHaveLength(0);
  });

  it("does both: rewinds, then forks from the same turn", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind and fork from here" }));
    await flush();
    expect(ipc.rewindTalkFiles).toHaveBeenCalledWith("ws-1", "/repo", "t1", 3, "abc1234");
    expect(ipc.forkChatThread).toHaveBeenCalledWith("/repo", "t1", 3);
    expect(useChatStore.getState().activeThreadByWs["ws-1"]).toBe("t2");
  });

  it("forks into a new thread whose composer takes the turn's text once", async () => {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Fork from here" })[1]);
    await flush();
    expect(ipc.forkChatThread).toHaveBeenCalledWith("/repo", "t1", 3);
    const s = useChatStore.getState();
    expect(s.activeThreadByWs["ws-1"]).toBe("t2");
    expect(s.threadsByWs["ws-1"][0].id).toBe("t2");
    expect(s.takeComposerSeed("ws-1")).toBe("Make it stream");
    expect(useChatStore.getState().takeComposerSeed("ws-1")).toBeNull();
    expect(toasts.at(-1)!.title).toBe("Forked into a new conversation.");
  });
});

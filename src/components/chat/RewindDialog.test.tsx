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
const { useTourStore, TOUR_IDLE } = await import("../../stores/tourStore");

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
  vi.clearAllMocks();
  useTourStore.setState({ ...TOUR_IDLE });
  vi.mocked(ipc.listChatThreads).mockResolvedValue([THREAD]);
  vi.mocked(ipc.listChatMessages).mockResolvedValue(ROWS);
  // Only the second turn took a checkpoint (the first ran before checkpoints).
  vi.mocked(ipc.listTalkCheckpoints).mockResolvedValue({ turns: [3], skipped: [], canUndo: false });
  vi.mocked(ipc.previewTalkRewind).mockResolvedValue({
    messageId: 3,
    current: "abc1234",
    changes: [
      { path: "src/parser.ts", kind: "reverted", outsideTalk: false },
      { path: "src/stream.ts", kind: "removed", outsideTalk: false },
      { path: "README.md", kind: "reverted", outsideTalk: true },
    ],
    untouched: [],
  });
  vi.mocked(ipc.rewindTalkFiles).mockResolvedValue({ changed: 3, untouched: [], error: null, canUndo: true });
  vi.mocked(ipc.undoTalkRewind).mockResolvedValue({ changed: 3, untouched: [], error: null, canUndo: false });
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
    expect(ipc.listTalkCheckpoints).toHaveBeenCalledWith("t1");
  });

  it("shows what will change before writing, then rewinds the previewed tree and offers the undo", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(ipc.previewTalkRewind).toHaveBeenCalledWith("t1", 3);
    expect(screen.getByText("3 files go back to before this turn.")).toBeInTheDocument();
    expect(screen.getByText("src/stream.ts")).toBeInTheDocument();
    expect(screen.getByText("changed outside")).toBeInTheDocument();
    expect(screen.getByText(/1 of them was changed outside this conversation/)).toBeInTheDocument();
    expect(ipc.rewindTalkFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    expect(ipc.rewindTalkFiles).toHaveBeenCalledWith("t1", 3, "abc1234");
    expect(ipc.forkChatThread).not.toHaveBeenCalled();
    expect(screen.queryByText("3 files go back to before this turn.")).not.toBeInTheDocument();
    const toast = toasts.at(-1)!;
    expect(toast.title).toBe("Rewound 3 files.");
    expect(toast.action?.label).toBe("Undo the rewind");

    toast.action!.onClick();
    await flush();
    expect(ipc.undoTalkRewind).toHaveBeenCalledWith("t1");
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
    expect(ipc.rewindTalkFiles).toHaveBeenCalledWith("t1", 3, "abc1234");
    expect(ipc.forkChatThread).toHaveBeenCalledWith("t1", 3);
    expect(useChatStore.getState().activeThreadByWs["ws-1"]).toBe("t2");
  });

  it("when the fork fails after the rewind, closes the dialog, offers the undo and reports the fork on its own", async () => {
    vi.mocked(ipc.forkChatThread).mockRejectedValue("other: That conversation no longer exists.");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind and fork from here" }));
    await flush();
    expect(ipc.rewindTalkFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("3 files go back to before this turn.")).not.toBeInTheDocument();
    expect(toasts.map((t) => t.title)).toEqual(["Rewound 3 files.", "The files are rewound, but the fork failed."]);
    expect(toasts[0].action?.label).toBe("Undo the rewind");
    expect(toasts[1].body).toBe("That conversation no longer exists.");
  });

  it("shows the loading state with nothing callable while the preview is read", async () => {
    vi.mocked(ipc.previewTalkRewind).mockReturnValue(new Promise(() => {}));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(screen.getByText("Reading the files…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rewind the files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rewind and fork from here" })).toBeDisabled();
    const dialog = document.querySelector('[data-tour="talk-rewind-dialog"]')!;
    for (const icon of dialog.querySelectorAll("svg")) expect(icon.closest("[title]")).not.toBeNull();
  });

  it("says a turn can't be rewound, with the reason, and offers nothing to confirm", async () => {
    vi.mocked(ipc.previewTalkRewind).mockRejectedValue("other: This turn has no checkpoint.");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(screen.getByText("This turn can't be rewound.")).toBeInTheDocument();
    expect(screen.getByText("This turn has no checkpoint.")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Rewind the files" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rewind and fork from here" })).toBeDisabled();
    fireEvent.click(confirm);
    await flush();
    expect(ipc.rewindTalkFiles).not.toHaveBeenCalled();
  });

  it("says the files already match when nothing would change, with both actions disabled", async () => {
    vi.mocked(ipc.previewTalkRewind).mockResolvedValue({ messageId: 3, current: "abc1234", changes: [], untouched: [] });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(screen.getByText("The files already match this turn.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "What will change" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rewind the files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rewind and fork from here" })).toBeDisabled();
  });

  it("closes on Escape and on Cancel without writing anything", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(screen.getByText("3 files go back to before this turn.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(screen.queryByText("3 files go back to before this turn.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(screen.queryByText("3 files go back to before this turn.")).not.toBeInTheDocument();
    expect(ipc.rewindTalkFiles).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it("lists the paths a rewind leaves untouched, with the reason, and says where checkpoints are stored", async () => {
    vi.mocked(ipc.previewTalkRewind).mockResolvedValue({
      messageId: 3,
      current: "abc1234",
      changes: [{ path: "src/parser.ts", kind: "reverted", outsideTalk: false }],
      untouched: [
        { path: "local.cfg", reason: "ignored" },
        { path: "vendor", reason: "exists" },
      ],
    });
    vi.mocked(ipc.rewindTalkFiles).mockResolvedValue({
      changed: 1,
      untouched: [{ path: "local.cfg", reason: "ignored" }],
      error: null,
      canUndo: true,
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    expect(screen.getByText("2 paths differ but are left untouched.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Left untouched" });
    expect(list).toHaveTextContent("local.cfg");
    expect(list).toHaveTextContent("git-ignored");
    expect(list).toHaveTextContent("not in the snapshot");
    expect(screen.getByText(/git objects under refs\/octopush\/talk\//)).toBeInTheDocument();
    expect(screen.getByText(/git-ignored now or was at that turn/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    expect(toasts.at(-1)!.title).toBe("Rewound 1 file; 1 left untouched.");
  });

  it("keeps the dialog open when a rewind stops part-way and offers the undo there", async () => {
    vi.mocked(ipc.rewindTalkFiles).mockResolvedValue({
      changed: 2,
      untouched: [],
      error: "checkout-index: unable to create file src/parser.ts",
      canUndo: true,
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind and fork from here" }));
    await flush();
    expect(screen.getByText("The rewind stopped part-way.")).toBeInTheDocument();
    expect(screen.getByText(/2 files were changed before it stopped: checkout-index: unable to create file/)).toBeInTheDocument();
    expect(ipc.forkChatThread).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rewind the files" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo the rewind" }));
    await flush();
    expect(ipc.undoTalkRewind).toHaveBeenCalledWith("t1");
    expect(toasts.at(-1)!.title).toBe("The files are back as they were.");
    expect(screen.queryByText("The rewind stopped part-way.")).not.toBeInTheDocument();
  });

  it("says there is no undo when the state before a part-way rewind could not be kept", async () => {
    vi.mocked(ipc.rewindTalkFiles).mockResolvedValue({ changed: 1, untouched: [], error: "it failed", canUndo: false });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    expect(screen.getByText(/1 file was changed before it stopped: it failed.*there is no undo/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo the rewind" })).not.toBeInTheDocument();
  });

  it("says a turn has no checkpoint, with the reason, where Rewind would be", async () => {
    vi.mocked(ipc.listTalkCheckpoints).mockResolvedValue({
      turns: [],
      skipped: [{ messageId: 3, reason: "more than 5000 changed or untracked files" }],
      canUndo: false,
    });
    await mount();
    expect(screen.queryByRole("button", { name: "Rewind files to here" })).not.toBeInTheDocument();
    const mark = screen.getByRole("img", { name: "This turn has no checkpoint: more than 5000 changed or untracked files" });
    expect(mark).toHaveAttribute("title", "This turn has no checkpoint: more than 5000 changed or untracked files");
  });

  it("reports an undo the backend refuses", async () => {
    vi.mocked(ipc.undoTalkRewind).mockRejectedValue(
      "other: The files changed since the rewind, so it can't be undone without losing those changes.",
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rewind files to here" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Rewind the files" }));
    await flush();
    toasts.at(-1)!.action!.onClick();
    await flush();
    const t = toasts.at(-1)!;
    expect(t.title).toBe("Couldn't undo the rewind.");
    expect(t.body).toBe("The files changed since the rewind, so it can't be undone without losing those changes.");
  });

  it("shows a user turn's hidden actions while a tour points at them", async () => {
    await mount();
    const fork = screen.getAllByRole("button", { name: "Fork from here" })[0];
    const bar = fork.closest('[data-tour="talk-turn-actions"]') as HTMLElement;
    expect(bar).not.toBeNull();
    // Bare classes only: `group-hover/msg:opacity-100` is always there.
    const hidden = /(^|\s)opacity-0(\s|$)/;
    const shown = /(^|\s)opacity-100(\s|$)/;
    expect(bar.className).toMatch(hidden);
    act(() => useTourStore.setState({ active: true, target: fork }));
    expect(bar.className).toMatch(shown);
    expect(bar.className).not.toMatch(hidden);
    act(() => useTourStore.setState({ ...TOUR_IDLE }));
    expect(bar.className).toMatch(hidden);
  });

  it("keeps a seed the composer hasn't taken yet when another fork follows", async () => {
    await mount();
    useChatStore.setState({ composerSeedByWs: { "ws-1": "an earlier seed" } });
    await useChatStore.getState().forkThread("ws-1", "t1", 3);
    expect(useChatStore.getState().takeComposerSeed("ws-1")).toBe("an earlier seed\n\nMake it stream");
  });

  it("forks into a new thread whose composer takes the turn's text once", async () => {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Fork from here" })[1]);
    await flush();
    expect(ipc.forkChatThread).toHaveBeenCalledWith("t1", 3);
    const s = useChatStore.getState();
    expect(s.activeThreadByWs["ws-1"]).toBe("t2");
    expect(s.threadsByWs["ws-1"][0].id).toBe("t2");
    expect(s.takeComposerSeed("ws-1")).toBe("Make it stream");
    expect(useChatStore.getState().takeComposerSeed("ws-1")).toBeNull();
    expect(toasts.at(-1)!.title).toBe("Forked into a new conversation.");
  });
});

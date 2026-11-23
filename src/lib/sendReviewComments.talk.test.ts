/**
 * "Send to the agent" on the Talk path, against the real chat store: a Talk
 * turn runs for minutes and `chatStore.send` resolves only when it ends, so
 * the sends here stay pending until the test ends them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }));
vi.mock("../components/Toasts", () => ({ pushToast: pushToastMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("./ipc", async () => {
  const actual = await vi.importActual<any>("./ipc");
  return {
    ...actual,
    ipc: {
      sendChatMessage: vi.fn(),
      listChatMessages: vi.fn().mockResolvedValue([]),
      listChatThreads: vi.fn().mockResolvedValue([]),
      createChatThread: vi.fn().mockResolvedValue({ id: "t1", workspaceId: "w1", title: "New conversation", createdAt: "t", updatedAt: "t" }),
      renameChatThread: vi.fn().mockResolvedValue(undefined),
      pendingSubagentCaps: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ipc } from "./ipc";
import { sendReviewComments } from "./sendReviewComments";
import { NAVIGATE_EVENT } from "./tour/surfaces";
import { useReviewComments } from "../stores/reviewCommentsStore";
import { useRunsStore } from "../stores/runsStore";
import { useChatStore } from "../stores/chatStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const note = { filePath: "a.ts", fingerprint: "f1", startLine: 2, endLine: 2, quote: ["+x"], note: "Rename x." };
const sendIpc = ipc.sendChatMessage as ReturnType<typeof vi.fn>;
const tray = () => (useReviewComments.getState().byWs.w1 ?? []).map((c) => c.note);

describe("sendReviewComments → Talk, with a turn that takes its time", () => {
  const modes: string[] = [];
  const onNav = (e: Event) => modes.push((e as CustomEvent).detail.mode);
  /** A turn in flight: `end` lets it run through, `fail` rejects it. */
  let end!: () => void;
  let fail!: (e: unknown) => void;

  beforeEach(() => {
    modes.length = 0;
    pushToastMock.mockClear();
    sendIpc.mockReset();
    sendIpc.mockImplementation(() => new Promise<void>((res, rej) => { end = res; fail = rej; }));
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    window.removeEventListener(NAVIGATE_EVENT, onNav);
    window.addEventListener(NAVIGATE_EVENT, onNav);
    useReviewComments.setState({ byWs: {}, liveByWs: {} });
    useRunsStore.setState({ runsByWs: {}, detailByRun: {}, runErrors: {} });
    useChatStore.setState({ messagesByWs: {}, streamingByWs: {}, errorByWs: {}, threadsByWs: {}, activeThreadByWs: {}, attachmentsByWs: {} });
    useWorkspaceStore.setState({ activeId: "w1" });
    useReviewComments.getState().add("w1", note);
  });

  it("shows Talk as soon as the turn is dispatched, not when it ends", async () => {
    let done = false;
    const sending = sendReviewComments("w1", "/w1").then(() => { done = true; });
    await vi.waitFor(() => expect(sendIpc).toHaveBeenCalledTimes(1));
    // The turn is still running: the director is already in Talk, the tray empty.
    expect(modes).toEqual(["talk"]);
    expect(done).toBe(false);
    expect(tray()).toEqual([]);
    expect(sendIpc.mock.calls[0][0].userMessage).toContain("Rename x.");
    end();
    await sending;
    expect(modes).toEqual(["talk"]);
    expect(tray()).toEqual([]);
  });

  it("doesn't pull a director who moved to another workspace: a toast says where they went", async () => {
    useWorkspaceStore.setState({ activeId: "w2" });
    const sending = sendReviewComments("w1", "/w1");
    await vi.waitFor(() => expect(sendIpc).toHaveBeenCalledTimes(1));
    expect(modes).toEqual([]);
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Comments sent" }));
    end();
    await sending;
    expect(modes).toEqual([]);
  });

  it("restores nothing when the turn fails midway: the message is already in the thread", async () => {
    const sending = sendReviewComments("w1", "/w1");
    await vi.waitFor(() => expect(sendIpc).toHaveBeenCalledTimes(1));
    const message = sendIpc.mock.calls[0][0].userMessage as string;
    // The backend took the message, then the provider failed.
    (ipc.listChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, workspaceId: "w1", role: "user", content: message },
      { id: 2, workspaceId: "w1", role: "error", content: "provider down" },
    ]);
    fail("provider down");
    await sending;
    // Putting them back would deliver the comments twice on the next send.
    expect(tray()).toEqual([]);
    expect(modes).toEqual(["talk"]);
  });

  it("puts the comments back when the backend refused the turn before taking the message", async () => {
    const sending = sendReviewComments("w1", "/w1");
    await vi.waitFor(() => expect(sendIpc).toHaveBeenCalledTimes(1));
    useReviewComments.getState().add("w1", { ...note, note: "Later." });
    fail("budget exceeded");
    await sending;
    expect(tray()).toEqual(["Rename x.", "Later."]);
  });

  it("a pre-flight refusal puts them back and stays in Review", async () => {
    const { ensureThread } = useChatStore.getState();
    useChatStore.setState({ ensureThread: async () => "" });
    try {
      await sendReviewComments("w1", "/w1");
    } finally {
      useChatStore.setState({ ensureThread });
    }
    expect(sendIpc).not.toHaveBeenCalled();
    expect(tray()).toEqual(["Rename x."]);
    expect(modes).toEqual([]);
    expect(pushToastMock).not.toHaveBeenCalled();
  });
});

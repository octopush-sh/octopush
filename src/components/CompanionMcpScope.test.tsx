/**
 * Companion → Conversation → "can use": one chip per configured MCP server,
 * its live status, and a per-conversation off switch persisted through the
 * store and IPC; the row re-reads on the backend's MCP events.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { McpServerStatus } from "../lib/types";

const mcpListeners: Array<() => void> = [];
const listMcpServerStatus = vi.fn();
const getThreadMcpDisabled = vi.fn();
const setThreadMcpServer = vi.fn();
const unlisten = vi.fn();
const onMcpChanged = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listMcpServerStatus: (...a: unknown[]) => listMcpServerStatus(...a),
    getThreadMcpDisabled: (...a: unknown[]) => getThreadMcpDisabled(...a),
    setThreadMcpServer: (...a: unknown[]) => setThreadMcpServer(...a),
    onMcpChanged: (h: () => void) => onMcpChanged(h),
    listSkills: () => Promise.resolve([]),
    listSubagentTypes: () => Promise.resolve([]),
    listMcpTrust: (...a: unknown[]) => listMcpTrust(...a),
  },
}));
const listMcpTrust = vi.fn();

/** The backend's per-thread lists: one server set per write, as the command does. */
let stored: Record<string, string[]> = {};
const backendSet = (t: string, server: string, off: boolean) => {
  const rest = (stored[t] ?? []).filter((n) => n !== server);
  stored[t] = (off ? [...rest, server] : rest).sort();
  return Promise.resolve(stored[t]);
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

import { useChatStore } from "../stores/chatStore";
import { useMcpScopeStore } from "../stores/mcpScopeStore";
import { CompanionMcpScope, chipTitle, chipTone } from "./CompanionMcpScope";

const docs: McpServerStatus = { name: "docs-server", state: "connected", tools: 12, reason: null };
const remote: McpServerStatus = { name: "example-remote", state: "failed", tools: null, reason: "spawn /x: No such file" };

async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CompanionMcpScope worktreePath="/wt" workspaceId="ws" />);
  });
  return view;
}
const chip = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  mcpListeners.length = 0;
  stored = {};
  unlisten.mockReset();
  onMcpChanged.mockReset().mockImplementation((h: () => void) => {
    mcpListeners.push(h);
    return Promise.resolve(unlisten);
  });
  listMcpServerStatus.mockReset().mockResolvedValue([docs, remote]);
  getThreadMcpDisabled.mockReset().mockImplementation((t: string) => Promise.resolve(stored[t] ?? []));
  setThreadMcpServer.mockReset().mockImplementation(backendSet);
  useMcpScopeStore.setState({ statusByPath: {}, offByThread: {}, trustByPath: {} });
  listMcpTrust.mockReset().mockResolvedValue([]);
  useChatStore.setState({ activeThreadByWs: { ws: "t-1" }, streamingByWs: {} });
});

describe("chipTitle / chipTone", () => {
  it("says the state, the tool count and what a click does", () => {
    expect(chipTitle(docs, false, true)).toBe("docs-server · connected · 12 tools · click to turn off in this conversation");
    expect(chipTitle({ ...docs, tools: 1 }, false, true)).toBe("docs-server · connected · 1 tool · click to turn off in this conversation");
    expect(chipTitle({ ...docs, state: "idle", tools: null }, false, false)).toBe("docs-server · not started yet · it starts on first use");
    expect(chipTitle(remote, false, true)).toBe("example-remote · failed: spawn /x: No such file · click to turn off in this conversation");
    expect(chipTitle(remote, true, true)).toBe("example-remote · off in this conversation · click to turn it back on");
  });

  it("says what the user trusts on the server (#1243)", () => {
    expect(chipTitle(docs, false, true, { server: "docs-server", config: "c", all: false, tools: ["post_note", "tag_page"] })).toBe(
      "docs-server · connected · 12 tools · runs post_note, tag_page without asking in Edit freely; one it marks destructive still asks (Settings › Integrations revokes it) · click to turn off in this conversation",
    );
    expect(chipTitle(docs, false, false, { server: "docs-server", config: "c", all: true, tools: [] })).toBe(
      "docs-server · connected · 12 tools · runs every tool without asking in Edit freely; one it marks destructive still asks (Settings › Integrations revokes it)",
    );
  });

  it("colours by status, never brass, and off is mute", () => {
    expect(chipTone("connected", false)).toBe("text-octo-verdigris");
    expect(chipTone("failed", false)).toBe("text-octo-rouge");
    expect(chipTone("idle", false)).toBe("text-octo-mute");
    expect(chipTone("connected", true)).toBe("text-octo-mute");
  });
});

describe("CompanionMcpScope", () => {
  it("is hidden when no server is configured", async () => {
    listMcpServerStatus.mockResolvedValue([]);
    await mount();
    expect(screen.queryByText("can use")).toBeNull();
  });

  it("renders a chip per server with its status, and says where the servers come from", async () => {
    await mount();
    expect(listMcpServerStatus).toHaveBeenCalledWith("/wt");
    expect(getThreadMcpDisabled).toHaveBeenCalledWith("t-1");
    expect(screen.getByText("can use")).toHaveAttribute("title", expect.stringContaining("Settings › Integrations"));
    expect(screen.getByTestId("companion-can-use")).toHaveAttribute("data-tour", "companion-can-use");
    const d = chip("docs-server");
    expect(d).toHaveAttribute("aria-pressed", "true");
    expect(d).toHaveAttribute("data-state", "connected");
    expect(d.title).toBe("docs-server · connected · 12 tools · click to turn off in this conversation");
    expect(d.querySelector("svg")).toHaveClass("text-octo-verdigris");
    expect(chip("example-remote").querySelector("svg")).toHaveClass("text-octo-rouge");
    expect(chip("example-remote").title).toContain("failed: spawn /x: No such file");
  });

  it("marks a trusted server's chip and says what it may run (#1243)", async () => {
    listMcpTrust.mockResolvedValue([{ server: "docs-server", config: "c", all: true, tools: [] }]);
    await mount();
    // Read for this worktree: a server its own .claude/mcp.json defines has none.
    expect(listMcpTrust).toHaveBeenCalledWith("/wt");
    expect(chip("docs-server").querySelector('[data-testid="chip-trusted"]')).not.toBeNull();
    expect(chip("docs-server").title).toContain("runs every tool without asking in Edit freely");
    expect(chip("example-remote").querySelector('[data-testid="chip-trusted"]')).toBeNull();
  });

  it("a click turns a server off in this conversation only, persists it, and a second click turns it back on", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(chip("docs-server"));
    });
    expect(setThreadMcpServer).toHaveBeenLastCalledWith("t-1", "docs-server", true);
    const d = chip("docs-server");
    expect(d).toHaveAttribute("aria-pressed", "false");
    expect(d.title).toBe("docs-server · off in this conversation · click to turn it back on");
    expect(screen.getByText("docs-server")).toHaveClass("line-through");
    expect(useMcpScopeStore.getState().offByThread).toEqual({ "t-1": ["docs-server"] });

    await act(async () => {
      fireEvent.click(chip("docs-server"));
    });
    expect(setThreadMcpServer).toHaveBeenLastCalledWith("t-1", "docs-server", false);
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "true");
  });

  it("re-reads the stored list when the write fails", async () => {
    setThreadMcpServer.mockRejectedValue(new Error("db locked"));
    await mount();
    await act(async () => {
      fireEvent.click(chip("example-remote"));
    });
    expect(chip("example-remote")).toHaveAttribute("aria-pressed", "true");
    expect(useMcpScopeStore.getState().offByThread["t-1"]).toEqual([]);
  });

  it("reads each conversation's own off list", async () => {
    stored = { "t-2": ["docs-server"] };
    await mount();
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      useChatStore.setState({ activeThreadByWs: { ws: "t-2" } });
    });
    expect(getThreadMcpDisabled).toHaveBeenLastCalledWith("t-2");
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "false");
  });

  it("re-reads the status on an MCP event and when a turn settles, and unsubscribes on unmount", async () => {
    const view = await mount();
    expect(mcpListeners).toHaveLength(1);
    listMcpServerStatus.mockResolvedValue([{ ...docs, state: "idle", tools: null }]);
    await act(async () => {
      mcpListeners[0]();
    });
    expect(screen.queryByText("example-remote")).toBeNull();
    expect(chip("docs-server")).toHaveAttribute("data-state", "idle");

    const calls = listMcpServerStatus.mock.calls.length;
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: true } });
    });
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: false } });
    });
    expect(listMcpServerStatus.mock.calls.length).toBe(calls + 2);

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("shows the chips without a toggle before the conversation exists", async () => {
    useChatStore.setState({ activeThreadByWs: {} });
    await mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("docs-server").parentElement).toHaveAttribute("title", "docs-server · connected · 12 tools");
  });

  it("a slower, older status answer never overwrites a newer one", async () => {
    let first!: (v: McpServerStatus[]) => void;
    listMcpServerStatus
      .mockImplementationOnce(() => new Promise((r) => (first = r)))
      .mockResolvedValueOnce([docs]);
    const store = useMcpScopeStore.getState();
    const a = store.loadStatus("/wt");
    await store.loadStatus("/wt");
    first([docs, remote]);
    await a;
    expect(useMcpScopeStore.getState().statusByPath["/wt"]).toEqual([docs]);
  });

  it("ignores a click right after a thread switch until that thread's list has loaded", async () => {
    stored = { "t-2": ["docs-server"] };
    await mount();
    const load = deferred<string[]>();
    getThreadMcpDisabled.mockImplementation(() => load.promise);
    await act(async () => {
      useChatStore.setState({ activeThreadByWs: { ws: "t-2" } });
    });
    expect(chip("docs-server")).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(chip("docs-server"));
    });
    expect(setThreadMcpServer).not.toHaveBeenCalled();
    await act(async () => {
      load.resolve(["docs-server"]);
    });
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      fireEvent.click(chip("docs-server"));
    });
    expect(setThreadMcpServer).toHaveBeenLastCalledWith("t-2", "docs-server", false);
    expect(stored["t-2"]).toEqual([]);
  });

  it("two quick clicks write in click order, one server each, and the last answer wins", async () => {
    await mount();
    const first = deferred<string[]>();
    setThreadMcpServer.mockImplementationOnce(() => first.promise);
    await act(async () => {
      fireEvent.click(chip("docs-server"));
      fireEvent.click(chip("docs-server"));
    });
    // The second write waits for the first: the backend sees off, then on.
    expect(setThreadMcpServer.mock.calls).toEqual([["t-1", "docs-server", true]]);
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      stored["t-1"] = ["docs-server"];
      first.resolve(["docs-server"]);
    });
    expect(setThreadMcpServer.mock.calls).toEqual([
      ["t-1", "docs-server", true],
      ["t-1", "docs-server", false],
    ]);
    // The first answer is stale by then and never flips the chip back.
    expect(chip("docs-server")).toHaveAttribute("aria-pressed", "true");
    expect(stored["t-1"]).toEqual([]);
  });

  it("a load that started before a click never overwrites what the click stored", async () => {
    useMcpScopeStore.setState({ offByThread: { "t-1": [] } });
    const load = deferred<string[]>();
    getThreadMcpDisabled.mockImplementationOnce(() => load.promise);
    const store = useMcpScopeStore.getState();
    const loading = store.loadOff("t-1");
    await store.toggle("t-1", "docs-server");
    load.resolve([]);
    await loading;
    expect(useMcpScopeStore.getState().offByThread["t-1"]).toEqual(["docs-server"]);
  });

  it("unsubscribes even when the subscription lands after unmount", async () => {
    const sub = deferred<() => void>();
    onMcpChanged.mockImplementation(() => sub.promise);
    const view = await mount();
    view.unmount();
    await act(async () => {
      sub.resolve(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

/**
 * Companion → Crew journal: shows the focused sub-agent (resolved row or live
 * tool), its report and its journal, loads the persisted log when nothing
 * streamed, and closes back to nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const getChatAgentLog = vi.fn();
vi.mock("../lib/ipc", () => ({
  CHAT_AGENT_LOG_EVENT: "chat://agent-log",
  ipc: { getChatAgentLog: (...a: unknown[]) => getChatAgentLog(...a) },
}));

import { useChatStore } from "../stores/chatStore";
import type { ChatMessage } from "../lib/types";
import { CompanionCrewJournal, findCrewAgent } from "./CompanionCrewJournal";

const toolRow = (id: number, callId: string): ChatMessage => ({
  id,
  workspaceId: "ws",
  role: "tool",
  content: JSON.stringify({
    callId,
    toolName: "Agent",
    toolInput: { description: "Check the tests", subagentType: "tester", model: "fast-1" },
    result: "All 12 tests pass.",
    agent: { ok: true, finished: true, closedAtCap: false, blocked: false, model: "fast-1", inputTokens: 2_000, outputTokens: 500, costUsd: 0.4, durationMs: 6_500, toolCalls: 4 },
  }),
  model: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: "",
} as unknown as ChatMessage);

beforeEach(() => {
  getChatAgentLog.mockReset().mockResolvedValue([]);
  useChatStore.setState({
    messagesByWs: { ws: [toolRow(1, "c1")] },
    liveToolsByWs: {},
    agentLogByCall: {},
    crewFocusByWs: {},
  });
});

describe("CompanionCrewJournal", () => {
  it("renders nothing without a focused sub-agent", () => {
    render(<CompanionCrewJournal workspaceId="ws" />);
    expect(screen.queryByTestId("crew-journal")).toBeNull();
  });

  it("shows the focused sub-agent's report and loads its persisted journal", async () => {
    getChatAgentLog.mockResolvedValue([
      { kind: "text", text: "running the suite" },
      { kind: "tool", tool: "run_command", hint: "npm test" },
      { kind: "tool_result", ok: true, detail: "12 passed" },
    ]);
    useChatStore.setState({ crewFocusByWs: { ws: "c1" } });
    await act(async () => {
      render(<CompanionCrewJournal workspaceId="ws" />);
    });
    expect(screen.getByText("Crew journal")).toBeInTheDocument();
    expect(screen.getByText("Check the tests")).toBeInTheDocument();
    expect(screen.getByTestId("crew-report")).toHaveTextContent("All 12 tests pass.");
    expect(screen.getByText(/tester · fast-1 · done · 2\.5k tokens · \$0\.40 · /)).toBeInTheDocument();
    expect(getChatAgentLog).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(screen.getByText("running the suite")).toBeInTheDocument());
    expect(screen.getByText("run_command")).toBeInTheDocument();
    expect(screen.getByText("12 passed")).toBeInTheDocument();
  });

  it("closes back to nothing and clears the focus", async () => {
    useChatStore.setState({ crewFocusByWs: { ws: "c1" } });
    await act(async () => {
      render(<CompanionCrewJournal workspaceId="ws" />);
    });
    fireEvent.click(screen.getByLabelText("Close the crew journal"));
    expect(useChatStore.getState().getCrewFocus("ws")).toBeNull();
    expect(screen.queryByTestId("crew-journal")).toBeNull();
  });

  it("finds a live sub-agent when no resolved row exists yet", () => {
    const agent = findCrewAgent(
      [],
      [{ callId: "l1", toolName: "Agent", toolInput: { description: "Live one" }, startedAt: "2026-01-01T00:00:00Z", done: false, ok: true, durationMs: null }],
      "l1",
    );
    expect(agent).toMatchObject({ callId: "l1", description: "Live one", status: "running" });
    expect(findCrewAgent([], [], "nope")).toBeNull();
  });
});

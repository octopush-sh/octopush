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
const continueSubagent = vi.fn();
vi.mock("../lib/ipc", () => ({
  CHAT_AGENT_LOG_EVENT: "chat://agent-log",
  ipc: {
    getChatAgentLog: (...a: unknown[]) => getChatAgentLog(...a),
    continueSubagent: (...a: unknown[]) => continueSubagent(...a),
  },
}));

import { useChatStore } from "../stores/chatStore";
import type { ChatMessage } from "../lib/types";
import { CompanionCrewJournal, continueLabel, directorAnsweredAfter, findCrewAgent, statusWordFor } from "./CompanionCrewJournal";
import type { CrewAgent } from "./chat/CrewCard";

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
  continueSubagent.mockReset().mockResolvedValue(undefined);
  useChatStore.setState({
    messagesByWs: { ws: [toolRow(1, "c1")] },
    liveToolsByWs: {},
    agentLogByCall: {},
    crewFocusByWs: {},
    continuingCalls: {},
    continueErrorByCall: {},
  });
});

const agentWith = (meta: Partial<NonNullable<CrewAgent["meta"]>> | null, status: CrewAgent["status"] = "done"): CrewAgent => ({
  callId: "c1",
  description: "d",
  subagentType: null,
  model: null,
  tier: null,
  effort: null,
  askedModel: null,
  askedHonored: true,
  status,
  startedAt: null,
  durationMs: null,
  report: null,
  meta: meta
    ? { ok: true, finished: true, closedAtCap: false, blocked: false, model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0, ...meta }
    : null,
});

describe("continueLabel / statusWordFor", () => {
  it("phrases the control by ending and by whether the user wrote something", () => {
    expect(continueLabel(agentWith({}), false, 15)).toBe("Give it 15 more turns");
    expect(continueLabel(agentWith({}), false, 1)).toBe("Give it 1 more turn");
    expect(continueLabel(agentWith({}), false, null)).toBe("Let it finish");
    expect(continueLabel(agentWith({}), true, 15)).toBe("Reply and continue");
    expect(continueLabel(agentWith({ blocked: true }), true, 5)).toBe("Answer and continue");
    expect(continueLabel(agentWith({ blocked: true }), false, 5)).toBe("Continue without an answer");
  });

  it("names the ending, and 'continuing' while a continuation runs", () => {
    expect(statusWordFor(agentWith({ closedAtCap: true }), false)).toBe("done · turn limit");
    expect(statusWordFor(agentWith({ blocked: true }), false)).toBe("needs a decision");
    expect(statusWordFor(agentWith(null, "running"), false)).toBe("running");
    expect(statusWordFor(agentWith({ ok: false }, "failed"), false)).toBe("failed");
    expect(statusWordFor(agentWith({}), true)).toBe("continuing");
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

  it("gives a finished sub-agent more turns from its own thread and marks it continuing", async () => {
    let finish: () => void = () => {};
    continueSubagent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    useChatStore.setState({ crewFocusByWs: { ws: "c1" } });
    await act(async () => {
      render(<CompanionCrewJournal workspaceId="ws" />);
    });
    fireEvent.change(screen.getByLabelText("More turns to give"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Give it 30 more turns" }));
    expect(continueSubagent).toHaveBeenCalledWith("c1", null, 30);
    expect(useChatStore.getState().continuingCalls.c1).toBe(true);
    expect(screen.getByTestId("crew-journal-status")).toHaveTextContent("continuing");
    expect(screen.queryByLabelText("Reply to this sub-agent")).toBeNull();
    await act(async () => {
      finish();
    });
    expect(useChatStore.getState().continuingCalls.c1).toBeUndefined();
    expect(screen.getByLabelText("Reply to this sub-agent")).toBeInTheDocument();
  });

  it("sends the reply as the instruction and shows a failed continuation", async () => {
    continueSubagent.mockRejectedValue(new Error("This sub-agent has no saved run to continue"));
    useChatStore.setState({ crewFocusByWs: { ws: "c1" } });
    await act(async () => {
      render(<CompanionCrewJournal workspaceId="ws" />);
    });
    fireEvent.change(screen.getByLabelText("Reply to this sub-agent"), { target: { value: "Also check the e2e suite." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reply and continue" }));
    });
    // No turns picked = no limit on the continuation.
    expect(continueSubagent).toHaveBeenCalledWith("c1", "Also check the e2e suite.", null);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no saved run"));
  });

  it("warns when the director already went on with the report", async () => {
    const answer = { id: 2, workspaceId: "ws", role: "assistant", content: "Done, moving on.", model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: "" } as unknown as ChatMessage;
    expect(directorAnsweredAfter([toolRow(1, "c1"), answer], "c1")).toBe(true);
    expect(directorAnsweredAfter([answer, toolRow(3, "c1")], "c1")).toBe(false);
    expect(directorAnsweredAfter([toolRow(1, "c1")], null)).toBe(false);
    useChatStore.setState({ messagesByWs: { ws: [toolRow(1, "c1"), answer] }, crewFocusByWs: { ws: "c1" } });
    await act(async () => {
      render(<CompanionCrewJournal workspaceId="ws" />);
    });
    expect(screen.getByTestId("crew-moved-on")).toHaveTextContent("already went on");
  });

  it("a live (unfinished) sub-agent has no continue composer yet", () => {
    useChatStore.setState({
      messagesByWs: { ws: [] },
      liveToolsByWs: { ws: [{ callId: "l1", toolName: "Agent", toolInput: { description: "Live one" }, startedAt: "2026-01-01T00:00:00Z", done: false, ok: true, durationMs: null }] },
      crewFocusByWs: { ws: "l1" },
    });
    render(<CompanionCrewJournal workspaceId="ws" />);
    expect(screen.getByTestId("crew-journal")).toBeInTheDocument();
    expect(screen.queryByTestId("crew-continue")).toBeNull();
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

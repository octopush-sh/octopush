/**
 * The crew card: one Talk response's sub-agents as one surface. Under test —
 * the projection from live tools / resolved rows, the aggregate line, the
 * beacon law (exactly ONE pulsing row while the crew runs), and the row
 * affordances (journal focus into the store, inline report).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const getChatAgentLog = vi.fn();
vi.mock("../../lib/ipc", () => ({
  CHAT_AGENT_LOG_EVENT: "chat://agent-log",
  ipc: { getChatAgentLog: (...a: unknown[]) => getChatAgentLog(...a) },
}));

import { useChatStore, type LiveTool, type ToolExecution } from "../../stores/chatStore";
import { CrewCard, beaconCallId, crewAgentsFromLive, crewAgentsFromTools, crewSummary, runLine, shortModel } from "./CrewCard";

const live = (callId: string, startedAt: string, done = false, ok = true): LiveTool => ({
  callId,
  toolName: "Agent",
  toolInput: { description: `task ${callId}`, subagentType: "reviewer", promptChars: 10 },
  startedAt,
  done,
  ok,
  durationMs: done ? 900 : null,
});

const resolved = (id: number, callId: string, ok = true, extra: Partial<NonNullable<ToolExecution["agent"]>> = {}) => ({
  id,
  tool: {
    callId,
    toolName: "Agent",
    toolInput: { description: `task ${callId}`, subagentType: "reviewer", model: "fast-1" },
    result: `report for ${callId}`,
    agent: {
      ok, finished: true, closedAtCap: false, blocked: false, model: "fast-1",
      inputTokens: 1_000, outputTokens: 500, costUsd: 0.25, durationMs: 4_000, toolCalls: 3,
      ...extra,
    },
  } as ToolExecution,
});

beforeEach(() => {
  getChatAgentLog.mockReset().mockResolvedValue([]);
  useChatStore.setState({ agentLogByCall: {}, crewFocusByWs: {} });
});

describe("CrewCard — projections", () => {
  it("maps live tools and resolved rows to the same row shape", () => {
    const [a] = crewAgentsFromLive([live("c1", "2026-01-01T00:00:00Z")]);
    expect(a).toMatchObject({ callId: "c1", description: "task c1", subagentType: "reviewer", status: "running", report: null });
    const [b] = crewAgentsFromTools([resolved(7, "c2", false, { closedAtCap: true })]);
    expect(b).toMatchObject({ callId: "c2", status: "failed", model: "fast-1", report: "report for c2", durationMs: 4_000 });
    expect(b.meta?.closedAtCap).toBe(true);
  });

  it("the beacon is the longest-running sub-agent, none when the crew is done", () => {
    const agents = crewAgentsFromLive([
      live("late", "2026-01-01T00:00:10Z"),
      live("early", "2026-01-01T00:00:01Z"),
      live("done", "2026-01-01T00:00:00Z", true),
    ]);
    expect(beaconCallId(agents)).toBe("early");
    expect(beaconCallId(crewAgentsFromTools([resolved(1, "x")]))).toBeNull();
  });

  it("summarises counts, tokens and cost — only the parts that apply", () => {
    const liveOnly = crewAgentsFromLive([live("a", "2026-01-01T00:00:00Z"), live("b", "2026-01-01T00:00:00Z", true, false)]);
    expect(crewSummary(liveOnly)).toBe("1 running · 1 failed");
    const done = crewAgentsFromTools([resolved(1, "a"), resolved(2, "b")]);
    expect(crewSummary(done)).toBe("2 done · 3.0k tokens · $0.50");
  });

  it("appends the tier mix once a row's model maps to a tier", () => {
    // 3 fast rows × 1.5k tokens + 1 strong row × 1.5k → 75% fast · 25% strong.
    const crew = crewAgentsFromTools([
      resolved(1, "a", true, { tier: "fast" }),
      resolved(2, "b", true, { tier: "fast" }),
      resolved(3, "c", true, { tier: "fast" }),
      resolved(4, "d", true, { tier: "strong", model: "strong-1" }),
    ]);
    expect(crewSummary(crew)).toBe("4 done · 6.0k tokens · $1.00 · 75% fast · 25% strong");
    // Unmapped models never invent a tier line.
    expect(crewSummary(crewAgentsFromTools([resolved(1, "a")]))).toBe("1 done · 1.5k tokens · $0.25");
  });
});

describe("CrewCard — escalation", () => {
  it("marks a row whose first attempt was retried on a stronger model", () => {
    render(
      <CrewCard
        workspaceId="ws"
        agents={crewAgentsFromTools([resolved(1, "a", true, { model: "strong-1", tier: "strong", escalatedFrom: "fast-1" })])}
      />,
    );
    const tag = screen.getByText("escalated");
    expect(tag).toHaveAttribute("title", expect.stringContaining("fast-1"));
    expect(tag).toHaveAttribute("title", expect.stringContaining("strong-1"));
  });
});

describe("CrewCard — rendering", () => {
  it("renders one row per sub-agent with exactly one pulsing beacon while running", () => {
    render(
      <CrewCard
        workspaceId="ws"
        agents={crewAgentsFromLive([
          live("c1", "2026-01-01T00:00:05Z"),
          live("c2", "2026-01-01T00:00:01Z"),
          live("c3", "2026-01-01T00:00:00Z", true),
        ])}
      />,
    );
    expect(screen.getAllByTestId("crew-row")).toHaveLength(3);
    const beacons = document.querySelectorAll('[data-beacon="true"]');
    expect(beacons).toHaveLength(1);
    expect(beacons[0].closest('[data-testid="crew-row"]')).toHaveTextContent("task c2");
    expect(screen.getByText(/Crew ·/)).toBeInTheDocument();
    expect(screen.getByText("2 running · 1 done")).toBeInTheDocument();
  });

  it("a row focuses the sub-agent's journal in the store and loads its log", async () => {
    render(<CrewCard workspaceId="ws" agents={crewAgentsFromTools([resolved(1, "c1")])} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Open the work journal in the Companion"));
    });
    expect(useChatStore.getState().getCrewFocus("ws")).toBe("c1");
    expect(getChatAgentLog).toHaveBeenCalledWith("c1");
    expect(screen.getByTitle("Open the work journal in the Companion")).toHaveAttribute("aria-pressed", "true");
  });

  it("a finished row unfolds its report inline; a running row has no report", () => {
    render(<CrewCard workspaceId="ws" agents={crewAgentsFromTools([resolved(1, "c1")])} />);
    const toggle = screen.getByLabelText("Show report");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("report for c1")).toBeInTheDocument();

    render(<CrewCard workspaceId="ws2" agents={crewAgentsFromLive([live("r", "2026-01-01T00:00:00Z")])} />);
    expect(screen.getAllByLabelText("Show report")).toHaveLength(1);
  });

  it("a running row shows its latest journal activity", () => {
    useChatStore.setState({
      agentLogByCall: { c1: [{ kind: "text", text: "starting" }, { kind: "tool", tool: "grep", hint: "TODO" }] },
    });
    render(<CrewCard workspaceId="ws" agents={crewAgentsFromLive([live("c1", "2026-01-01T00:00:00Z")])} />);
    expect(screen.getByTitle("grep TODO")).toBeInTheDocument();
  });

  it("flags a turn-limit ending on the row", () => {
    render(<CrewCard workspaceId="ws" agents={crewAgentsFromTools([resolved(1, "c1", true, { closedAtCap: true })])} />);
    expect(screen.getByText("turn limit")).toBeInTheDocument();
  });
});

describe("CrewCard — what the run is on, from the first second", () => {
  it("reads model, tier, effort and the director's ask off the live card's input", () => {
    const t = live("c1", "2026-01-01T00:00:00Z");
    t.toolInput = { ...t.toolInput, model: "claude-sonnet-4-6", tier: "balanced", effort: "medium", askedModel: "strong", askedHonored: false };
    const [a] = crewAgentsFromLive([t]);
    expect(a).toMatchObject({ model: "claude-sonnet-4-6", tier: "balanced", effort: "medium", askedModel: "strong", askedHonored: false });
    expect(runLine(a)).toBe("sonnet-4-6 · medium");
    expect(shortModel("gpt-4o")).toBe("gpt-4o");
    render(<CrewCard workspaceId="ws" agents={[a]} />);
    expect(screen.getByTestId("crew-run-line")).toHaveTextContent("sonnet-4-6 · medium");
    const asked = screen.getByTestId("crew-asked");
    expect(asked).toHaveTextContent("asked strong");
    expect(asked).toHaveAttribute("title", expect.stringContaining("keeps its tier"));
  });

  it("an honored ask reads as such, and a row without a plan shows nothing extra", () => {
    const t = live("c2", "2026-01-01T00:00:00Z");
    t.toolInput = { ...t.toolInput, model: "claude-opus-5", tier: "strong", effort: "high", askedModel: "opus", askedHonored: true };
    render(<CrewCard workspaceId="ws" agents={crewAgentsFromLive([t])} />);
    expect(screen.getByTestId("crew-asked")).toHaveAttribute("title", expect.stringContaining("honors it"));
    render(<CrewCard workspaceId="ws2" agents={crewAgentsFromLive([live("c3", "2026-01-01T00:00:00Z")])} />);
    expect(screen.getAllByTestId("crew-run-line")).toHaveLength(1);
    expect(screen.getAllByTestId("crew-asked")).toHaveLength(1);
  });

  it("a resolved row prefers the outcome's model, tier and effort over the planned ones", () => {
    const row = resolved(1, "c1", true, { model: "claude-opus-5", tier: "strong", effort: "high" });
    row.tool.toolInput = { ...row.tool.toolInput, effort: "medium" };
    const [a] = crewAgentsFromTools([row]);
    expect(a.model).toBe("claude-opus-5");
    expect(a.tier).toBe("strong");
    expect(a.effort).toBe("high");
  });
});

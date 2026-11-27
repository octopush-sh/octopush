/**
 * Companion → Conversation → "can use": the `skills · N` and `agents · N`
 * counts beside the MCP chips, their popovers (name, one-line description,
 * source; an agent's tier or model and tools), and a skill row adding
 * `/name` to the composer's draft.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import type { McpServerStatus, SkillMeta } from "../lib/types";
import type { SubagentTypeMeta } from "../lib/ipc";

const listMcpServerStatus = vi.fn();
const listSkills = vi.fn();
const listSubagentTypes = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listMcpServerStatus: (...a: unknown[]) => listMcpServerStatus(...a),
    getThreadMcpDisabled: () => Promise.resolve([]),
    setThreadMcpServer: () => Promise.resolve([]),
    onMcpChanged: () => Promise.resolve(() => {}),
    listSkills: (...a: unknown[]) => listSkills(...a),
    listSubagentTypes: (...a: unknown[]) => listSubagentTypes(...a),
  },
}));

import { useChatStore } from "../stores/chatStore";
import { useMcpScopeStore } from "../stores/mcpScopeStore";
import { CompanionMcpScope } from "./CompanionMcpScope";
import { agentModelLabel, agentToolsLabel, sourceLabel } from "./CompanionCatalog";

const docs: McpServerStatus = { name: "docs-server", state: "connected", tools: 12, reason: null };
const skills: SkillMeta[] = [
  { name: "release-notes", description: "Write the release notes for a tag", source: "project" },
  { name: "tidy", description: "Tidy imports", source: "user" },
];
const agents: SubagentTypeMeta[] = [
  { name: "code-mapper", description: "Maps the code that matters", source: "builtin", tools: ["read_file", "grep", "glob"], model: "fast" },
  { name: "migrator", description: "Writes data migrations", source: "project", tools: null, model: "claude-sonnet-5-5" },
  { name: "scribe", description: "", source: "user", tools: [], model: null },
];

async function mount(path = "/wt") {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CompanionMcpScope worktreePath={path} workspaceId="ws" />);
  });
  return view;
}
const count = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  listMcpServerStatus.mockReset().mockResolvedValue([docs]);
  listSkills.mockReset().mockResolvedValue(skills);
  listSubagentTypes.mockReset().mockResolvedValue(agents);
  useMcpScopeStore.setState({ statusByPath: {}, offByThread: {} });
  useChatStore.setState({ activeThreadByWs: { ws: "t-1" }, streamingByWs: {}, draftInsertByWs: {} });
});

describe("labels", () => {
  it("names the source, the tier or model, and the tools", () => {
    expect(sourceLabel("builtin")).toBe("built-in");
    expect(sourceLabel("project")).toBe("project");
    expect(sourceLabel("plugin")).toBe("plugin");
    expect(agentModelLabel("haiku")).toBe("fast tier");
    expect(agentModelLabel("Strong")).toBe("strong tier");
    expect(agentModelLabel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(agentModelLabel(null)).toBe("Talk's model");
    expect(agentModelLabel("inherit")).toBe("Talk's model");
    expect(agentToolsLabel(null)).toBe("every tool");
    expect(agentToolsLabel([])).toBe("no tools");
    expect(agentToolsLabel(["read_file", "grep"])).toBe("read_file, grep");
  });
});

describe("skills and agents counts", () => {
  it("shows both counts after the MCP chips, read for the worktree", async () => {
    await mount();
    expect(listSkills).toHaveBeenCalledWith("/wt");
    expect(listSubagentTypes).toHaveBeenCalledWith("/wt");
    const s = count(/^skills · 2$/);
    const a = count(/^agents · 3$/);
    expect(s).toHaveAttribute("data-tour", "companion-can-use-skills");
    expect(a).toHaveAttribute("data-tour", "companion-can-use-agents");
    expect(s).toHaveClass("font-mono", "text-octo-mute");
    // The number changes on every rescan: tabular figures keep it from jittering.
    expect(within(s).getByText("2")).toHaveClass("octo-tabular");
    expect(within(a).getByText("3")).toHaveClass("octo-tabular");
    const row = screen.getByTestId("companion-can-use");
    expect(within(row).getByText("docs-server").compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the row with no MCP server, leaves out a zero count, and hides with nothing at all", async () => {
    listMcpServerStatus.mockResolvedValue([]);
    listSkills.mockResolvedValue([]);
    const view = await mount();
    expect(screen.getByText("can use")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^skills/ })).toBeNull();
    expect(count(/^agents · 3$/)).toBeInTheDocument();
    view.unmount();

    listSubagentTypes.mockResolvedValue([]);
    await mount();
    expect(screen.queryByText("can use")).toBeNull();
  });

  it("the skills popover lists names, descriptions and sources, and a click adds /name to the draft", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(count(/^skills/));
    });
    const menu = screen.getByRole("menu", { name: "Skills" });
    expect(menu.className).toContain("octo-menu-enter");
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("/release-notes");
    expect(rows[0]).toHaveTextContent("project");
    expect(rows[0]).toHaveTextContent("Write the release notes for a tag");
    expect(rows[1]).toHaveTextContent("user");
    expect(count(/^skills/)).toHaveAttribute("aria-expanded", "true");

    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(useChatStore.getState().draftInsertByWs["ws"]).toBe("/release-notes ");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the agents popover shows each agent's source, tier or model and tools, and changes nothing", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(count(/^agents/));
    });
    const menu = screen.getByRole("menu", { name: "Sub-agent types" });
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("code-mapper");
    expect(rows[0]).toHaveTextContent("built-in");
    expect(rows[0]).toHaveTextContent("Maps the code that matters");
    expect(rows[0]).toHaveTextContent("fast tier · read_file, grep, glob");
    expect(rows[1]).toHaveTextContent("claude-sonnet-5-5 · every tool");
    expect(rows[2]).toHaveTextContent("Talk's model · no tools");
    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(useChatStore.getState().draftInsertByWs["ws"]).toBeUndefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the earlier counts on screen while a reload is pending", async () => {
    await mount();
    let skillsDone!: (v: SkillMeta[]) => void;
    let agentsDone!: (v: SubagentTypeMeta[]) => void;
    listSkills.mockImplementationOnce(() => new Promise((r) => (skillsDone = r)));
    listSubagentTypes.mockImplementationOnce(() => new Promise((r) => (agentsDone = r)));
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: true } });
    });
    expect(count(/^skills · 2$/)).toBeInTheDocument();
    expect(count(/^agents · 3$/)).toBeInTheDocument();

    await act(async () => {
      skillsDone([skills[0]]);
      agentsDone([agents[0], agents[1]]);
    });
    expect(count(/^skills · 1$/)).toBeInTheDocument();
    expect(count(/^agents · 2$/)).toBeInTheDocument();
  });

  it("keeps the last reading when a re-read fails, and leaves a count out when the first read for a worktree fails", async () => {
    const view = await mount();
    listSkills.mockRejectedValueOnce(new Error("scan failed"));
    listSubagentTypes.mockResolvedValueOnce([agents[0]]);
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: true } });
    });
    expect(count(/^skills · 2$/)).toBeInTheDocument();
    expect(count(/^agents · 1$/)).toBeInTheDocument();

    listSkills.mockResolvedValueOnce([skills[1]]);
    listSubagentTypes.mockRejectedValueOnce(new Error("scan failed"));
    await act(async () => {
      view.rerender(<CompanionMcpScope worktreePath="/other" workspaceId="ws" />);
    });
    expect(count(/^skills · 1$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^agents/ })).toBeNull();
  });

  it("re-reads the lists when a turn settles and drops a late answer for another worktree", async () => {
    const view = await mount();
    const calls = listSkills.mock.calls.length;
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: true } });
    });
    expect(listSkills.mock.calls.length).toBe(calls + 1);

    let late!: (v: SkillMeta[]) => void;
    listSkills.mockImplementationOnce(() => new Promise((r) => (late = r)));
    listSkills.mockResolvedValueOnce([skills[1]]);
    await act(async () => {
      view.rerender(<CompanionMcpScope worktreePath="/other" workspaceId="ws" />);
    });
    await act(async () => {
      view.rerender(<CompanionMcpScope worktreePath="/third" workspaceId="ws" />);
    });
    await act(async () => {
      late(skills);
    });
    expect(count(/^skills · 1$/)).toBeInTheDocument();
  });
});

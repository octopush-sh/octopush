import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { McpServerStatus } from "../../lib/types";

const statusMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());
const changedMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../../lib/ipc");
  return {
    ...actual,
    ipc: { ...actual.ipc, listUserMcpServerStatus: statusMock, listMcpServerStatus: projectMock, onMcpChanged: changedMock },
  };
});

const { StageMcpServers, mcpUnavailableTitle, stageMcpChipTitle, stageMcpChips, stageMcpNote } = await import(
  "./StageMcpServers"
);
const { graphToStageDrafts, newStageData } = await import("./graph");

const SERVERS: McpServerStatus[] = [
  { name: "docs", state: "connected", tools: 3, reason: null },
  { name: "tracker", state: "failed", tools: null, reason: "spawn npx: not found" },
];
const EMPTY_LINE = "No MCP servers in Settings › Integrations.";

beforeEach(() => {
  changedMock.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  statusMock.mockReset();
  projectMock.mockReset();
  changedMock.mockReset();
});

function renderField(chosen: string[] | undefined, substrate: "api" | "cli" = "api", model = "claude-sonnet-5-5") {
  if (!statusMock.getMockImplementation()) statusMock.mockResolvedValue(SERVERS);
  const onChange = vi.fn();
  render(<StageMcpServers substrate={substrate} model={model} chosen={chosen} onChange={onChange} />);
  return onChange;
}

describe("StageMcpServers", () => {
  it("says it is reading, never 'none configured', until the list arrives", async () => {
    let answer!: (s: McpServerStatus[]) => void;
    statusMock.mockImplementation(() => new Promise<McpServerStatus[]>((r) => (answer = r)));
    renderField(["docs"]);
    expect(screen.getByText("Reading the MCP servers…")).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    answer(SERVERS);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect(screen.queryByText("Reading the MCP servers…")).toBeNull();
  });

  it("says none are configured only once a read found none", async () => {
    statusMock.mockResolvedValue([]);
    renderField(undefined);
    expect(await screen.findByText(EMPTY_LINE)).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("doesn't claim none are configured when the read fails, and keeps the chosen servers", async () => {
    statusMock.mockRejectedValue(new Error("ipc down"));
    const onChange = renderField(["tracker"]);
    expect(await screen.findByText("Couldn't read the MCP servers in Settings › Integrations.")).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
    const chip = screen.getByRole("switch", { name: /tracker/ });
    expect(chip.getAttribute("title")).toBe("tracker · status unknown · click to take it off this stage");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("offers only the Settings servers, never a project's .claude/mcp.json", async () => {
    renderField(undefined);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect(statusMock).toHaveBeenCalledWith();
    expect(projectMock).not.toHaveBeenCalled();
    expect(stageMcpNote([], false)).toBe(EMPTY_LINE);
    expect(stageMcpNote(undefined, false)).toBe("Reading the MCP servers…");
  });

  it("tones every chip's icon by its server's status, on or off", async () => {
    renderField(["tracker"]);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    const [docsIcon, trackerIcon] = screen.getAllByTestId("stage-mcp-icon");
    // docs is off and connected, tracker is on and failed.
    expect(docsIcon.getAttribute("class")).toContain("text-octo-verdigris");
    expect(trackerIcon.getAttribute("class")).toContain("text-octo-rouge");
    const docs = screen.getByRole("switch", { name: /docs/ });
    expect(docs.className).toContain("border-octo-border-strong");
    expect(docs.className).toContain("duration-[var(--dur-quick)]");
    expect(screen.getByRole("switch", { name: /tracker/ }).className).toContain("text-octo-brass");
  });

  it("re-reads the list when the MCP config or status changes", async () => {
    let fire!: () => void;
    changedMock.mockImplementation(async (h: () => void) => {
      fire = h;
      return () => {};
    });
    renderField(undefined);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fire).toBeTypeOf("function"));
    act(() => fire());
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
  });

  it("lists the Settings servers, every one off by default", async () => {
    renderField(undefined);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    for (const chip of screen.getAllByRole("switch")) expect(chip.getAttribute("aria-checked")).toBe("false");
    expect(newStageData("review").mcpServers).toEqual([]);
  });

  it("turns a server on and off for the stage", async () => {
    const onChange = renderField(["tracker"]);
    const docs = await screen.findByRole("switch", { name: /docs/ });
    fireEvent.click(docs);
    expect(onChange).toHaveBeenLastCalledWith(["docs", "tracker"]);
    fireEvent.click(screen.getByRole("switch", { name: /tracker/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("is unavailable on a CLI stage, with the reason in its title", async () => {
    renderField([], "cli", "gpt-6.1-terra");
    const chip = await screen.findByRole("switch", { name: /docs/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.parentElement?.parentElement?.getAttribute("title")).toBe(mcpUnavailableTitle("gpt-6.1-terra"));
    expect(mcpUnavailableTitle("gpt-6.1-terra")).toMatch(/Codex's own MCP servers/);
    expect(mcpUnavailableTitle("claude-sonnet-5-5")).toMatch(/Claude Code's own MCP servers/);
  });

  it("keeps a chosen server that isn't in Settings, so it can be taken off", () => {
    expect(stageMcpChips(SERVERS, ["gone", "docs"]).map((c) => c.name)).toEqual(["docs", "tracker", "gone"]);
    expect(stageMcpChipTitle("gone", null, true)).toBe(
      "gone · not in Settings › Integrations · click to take it off this stage",
    );
    expect(stageMcpChipTitle("docs", SERVERS[0], false)).toBe("docs · connected · 3 tools · click to let this stage use it");
    expect(stageMcpChipTitle("tracker", SERVERS[1], false)).toMatch(/failed: spawn npx: not found/);
  });

  it("saves the choice on API stages only", () => {
    const node = (substrate: "api" | "cli") => ({
      id: substrate,
      type: "stage" as const,
      position: { x: 0, y: substrate === "api" ? 0 : 100 },
      data: { ...newStageData("implement"), substrate, mcpServers: ["tracker", "docs"] },
    });
    const [api, cli] = graphToStageDrafts([node("api"), node("cli")], []);
    expect(api.mcpServers).toEqual(["docs", "tracker"]);
    expect(cli.mcpServers).toEqual([]);
  });
});

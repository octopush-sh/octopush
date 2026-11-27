import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { McpServerStatus } from "../../lib/types";

const statusMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../../lib/ipc");
  return { ...actual, ipc: { ...actual.ipc, listMcpServerStatus: statusMock } };
});

const { StageMcpServers, mcpUnavailableTitle, stageMcpChipTitle, stageMcpChips } = await import("./StageMcpServers");
const { graphToStageDrafts, newStageData } = await import("./graph");

const SERVERS: McpServerStatus[] = [
  { name: "docs", state: "connected", tools: 3, reason: null },
  { name: "tracker", state: "failed", tools: null, reason: "spawn npx: not found" },
];

afterEach(() => {
  cleanup();
  statusMock.mockReset();
});

function renderField(chosen: string[] | undefined, substrate: "api" | "cli" = "api", model = "claude-sonnet-5-5") {
  statusMock.mockResolvedValue(SERVERS);
  const onChange = vi.fn();
  render(
    <StageMcpServers workspacePath="/ws/mcp" substrate={substrate} model={model} chosen={chosen} onChange={onChange} />,
  );
  return onChange;
}

describe("StageMcpServers", () => {
  it("lists the workspace's servers, every one off by default", async () => {
    renderField(undefined);
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    expect(statusMock).toHaveBeenCalledWith("/ws/mcp");
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

  it("keeps a chosen server that isn't configured here, so it can be taken off", () => {
    expect(stageMcpChips(SERVERS, ["gone", "docs"]).map((c) => c.name)).toEqual(["docs", "tracker", "gone"]);
    expect(stageMcpChipTitle("gone", null, true)).toBe(
      "gone · not configured on this Mac or in this project · click to take it off this stage",
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

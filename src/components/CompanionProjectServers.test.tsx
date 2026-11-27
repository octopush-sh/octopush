/**
 * #1245: a project's own MCP servers in the Companion and in Settings ›
 * Integrations, each with where it stands and a revoke action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ProjectMcpApproval, ProjectMcpServer } from "../lib/types";

const listProjectMcpServers = vi.fn();
const listProjectMcpApprovals = vi.fn();
const revokeProjectMcpServer = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listProjectMcpServers: (...a: unknown[]) => listProjectMcpServers(...a),
    listProjectMcpApprovals: () => listProjectMcpApprovals(),
    revokeProjectMcpServer: (...a: unknown[]) => revokeProjectMcpServer(...a),
    onMcpChanged: () => Promise.resolve(() => {}),
  },
}));

const { CompanionProjectServers, projectServerTitle } = await import("./CompanionProjectServers");
const { ProjectMcpApprovals } = await import("./settings/ProjectMcpApprovals");

const server = (name: string, state: ProjectMcpServer["state"]): ProjectMcpServer => ({
  name,
  command: "node",
  args: [`${name}.js`],
  envNames: ["TOKEN"],
  hash: `h-${name}`,
  state,
});

beforeEach(() => {
  vi.clearAllMocks();
  revokeProjectMcpServer.mockResolvedValue(true);
});

describe("CompanionProjectServers", () => {
  it("lists the project's servers with where each stands, and revokes an approved one", async () => {
    listProjectMcpServers.mockResolvedValue([server("docs", "approved"), server("jira", "waiting"), server("github", "clash")]);
    render(<CompanionProjectServers worktreePath="/ws/a" workspaceId="w" />);
    await screen.findByText("project servers");
    expect(listProjectMcpServers).toHaveBeenCalledWith("/ws/a");
    expect(screen.getByText("jira").parentElement).toHaveAttribute(
      "title",
      "jira · node jira.js · env TOKEN · waits for your approval · the next turn asks",
    );
    expect(screen.queryByRole("button", { name: "Revoke jira" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke docs" }));
    expect(revokeProjectMcpServer).toHaveBeenCalledWith("docs", { workspacePath: "/ws/a" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke docs" })).toBeNull());
    expect(projectServerTitle(server("x", "changed"))).toMatch(/changed since you approved it/);
    expect(projectServerTitle(server("x", "clash"))).toMatch(/your Settings server of this name runs instead/);
  });

  it("is hidden when the project defines no server", async () => {
    listProjectMcpServers.mockResolvedValue([]);
    const { container } = render(<CompanionProjectServers worktreePath="/ws/b" workspaceId="w" />);
    await waitFor(() => expect(listProjectMcpServers).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("ProjectMcpApprovals (Settings › Integrations)", () => {
  it("lists every approval and revokes one by its project", async () => {
    const approvals: ProjectMcpApproval[] = [
      { projectId: "p1", projectName: "Sample app", server: "docs", approvedAt: "2026-11-27T10:00:00Z" },
    ];
    listProjectMcpApprovals.mockResolvedValue(approvals);
    render(<ProjectMcpApprovals />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke docs in Sample app" }));
    expect(revokeProjectMcpServer).toHaveBeenCalledWith("docs", { projectId: "p1" });
    await waitFor(() => expect(screen.queryByText("Approved project servers")).toBeNull());
  });
});

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
  display: `node '${name}\\u{202e}.js' \u{b7} env TOKEN`,
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
      "jira · node 'jira\\u{202e}.js' · env TOKEN · waits for your approval · the next turn asks",
    );
    expect(screen.queryByRole("button", { name: "Revoke jira" })).toBeNull();
    let done!: (v: boolean) => void;
    revokeProjectMcpServer.mockImplementationOnce(() => new Promise<boolean>((r) => (done = r)));
    fireEvent.click(screen.getByRole("button", { name: "Revoke docs" }));
    expect(revokeProjectMcpServer).toHaveBeenCalledWith("docs", { workspacePath: "/ws/a" });
    // Not optimistic: approved until the revoke is done.
    expect(screen.getByRole("button", { name: "Revoke docs" })).toBeDisabled();
    done(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke docs" })).toBeNull());
    expect(projectServerTitle(server("x", "changed"))).toMatch(/changed since you approved it/);
    expect(projectServerTitle(server("x", "clash"))).toMatch(/your Settings server of this name runs instead/);
  });

  it("keeps a server approved and says why when the revoke fails", async () => {
    listProjectMcpServers.mockResolvedValue([server("docs", "approved")]);
    revokeProjectMcpServer.mockRejectedValueOnce("the database is locked");
    render(<CompanionProjectServers worktreePath="/ws/c" workspaceId="w" />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke docs" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't revoke docs: the database is locked");
    expect(screen.getByRole("button", { name: "Revoke docs" })).not.toBeDisabled();
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

  it("keeps the approval and shows the error when the revoke fails", async () => {
    listProjectMcpApprovals.mockResolvedValue([
      { projectId: "p1", projectName: "Sample app", server: "docs", approvedAt: "2026-11-27T10:00:00Z" },
    ]);
    revokeProjectMcpServer.mockRejectedValueOnce(new Error("no such project"));
    render(<ProjectMcpApprovals />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke docs in Sample app" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't revoke docs: no such project");
    expect(screen.getByRole("button", { name: "Revoke docs in Sample app" })).toBeInTheDocument();
  });
});

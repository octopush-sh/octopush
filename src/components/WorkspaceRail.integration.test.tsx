import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceRail, type ProjectGroup } from "./WorkspaceRail";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import type { Workspace } from "../lib/types";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    name: "Test WS",
    task: "",
    branch: "main",
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-05-16T00:00:00Z",
    lastActive: "2026-05-16T00:00:00Z",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    fromBranch: null,
    ...overrides,
  };
}

describe("WorkspaceRail - Integration Tests", () => {
  it("INTEGRATION: Right-click on workspace should trigger onContextMenu callback", async () => {
    const onContextMenu = vi.fn();
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project",
        workspaces: [makeWorkspace({ id: "ws-alpha", name: "Alpha" })],
      },
    ];

    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-alpha"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );

    const btn = screen.getByLabelText(/Alpha/);
    fireEvent.contextMenu(btn, { clientX: 100, clientY: 100 });

    expect(onContextMenu).toHaveBeenCalledWith("ws-alpha", 100, 100);
  });

  it("INTEGRATION: Rendering WorkspaceContextMenu should show it in DOM", async () => {
    render(
      <WorkspaceContextMenu
        x={100}
        y={200}
        workspaceName="Test Workspace"
        isMain={false}
        onRevealInFinder={vi.fn()}
        onCopyPath={vi.fn()}
        onCopyBranch={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenInTerminal={vi.fn()}
        onCustomize={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Menu should exist in DOM (MenuSurface portals it to document.body).
    const menu = screen.getByRole("menu", { name: "Workspace actions" });
    expect(menu).toBeInTheDocument();

    // Menu should be positioned at x, y
    const style = menu?.getAttribute("style");
    expect(style).toContain("left: 100px");
    expect(style).toContain("top: 200px");

    // Menu should have customize and delete buttons
    expect(screen.getByRole("menuitem", { name: /Customize/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete workspace/ })).toBeInTheDocument();
  });

  it("CRITICAL: Right-click on workspace 1 triggers callback", () => {
    const onContextMenu = vi.fn();
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project 1",
        workspaces: [
          makeWorkspace({ id: "ws-1", name: "WS-1" }),
          makeWorkspace({ id: "ws-2", name: "WS-2" }),
        ],
      },
    ];

    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-1"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.contextMenu(screen.getByLabelText(/WS-1/), { clientX: 10, clientY: 10 });
    expect(onContextMenu).toHaveBeenCalledWith("ws-1", 10, 10);
  });

  it("CRITICAL: Right-click on workspace 2 triggers callback", () => {
    const onContextMenu = vi.fn();
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project 1",
        workspaces: [
          makeWorkspace({ id: "ws-1", name: "WS-1" }),
          makeWorkspace({ id: "ws-2", name: "WS-2" }),
        ],
      },
    ];

    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-2"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.contextMenu(screen.getByLabelText(/WS-2/), { clientX: 20, clientY: 20 });
    expect(onContextMenu).toHaveBeenCalledWith("ws-2", 20, 20);
  });

  it("CRITICAL: Right-click on workspace from different project works", () => {
    const onContextMenu = vi.fn();
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project 1",
        workspaces: [makeWorkspace({ id: "ws-1", name: "WS-1" })],
      },
      {
        id: "proj-2",
        name: "Project 2",
        workspaces: [makeWorkspace({ id: "ws-2", name: "WS-2" })],
      },
    ];

    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-2"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.contextMenu(screen.getByLabelText(/WS-2/), { clientX: 30, clientY: 30 });
    expect(onContextMenu).toHaveBeenCalledWith("ws-2", 30, 30);
  });

  it("CRITICAL: Event handler not called twice on single right-click", () => {
    const onContextMenu = vi.fn();
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project",
        workspaces: [makeWorkspace({ id: "ws-1", name: "WS-1" })],
      },
    ];

    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-1"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.contextMenu(screen.getByLabelText(/WS-1/), { clientX: 40, clientY: 40 });

    // MUST be called exactly once, not twice
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

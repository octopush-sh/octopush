import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceRail, type ProjectGroup } from "./WorkspaceRail";
import type { Workspace } from "../lib/types";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    name: "Auth refactor",
    task: "",
    branch: "feat/auth",
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-05-16T00:00:00Z",
    lastActive: "2026-05-16T00:00:00Z",
    glyph: null,
    tint: null,
    ...overrides,
  };
}

describe("WorkspaceRail", () => {
  it("renders one button per workspace plus new workspace and toggle buttons", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
      makeWorkspace({ id: "c", name: "Gamma" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onNewWorkspace={vi.fn()}
      />,
    );
    // workspace buttons + new workspace button + toggle button
    expect(screen.getAllByRole("button")).toHaveLength(workspaces.length + 2);
  });

  it("renders the workspace monogram glyph", () => {
    const workspaces = [makeWorkspace({ name: "Hyperion" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-1"
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onNewWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByText("H")).toBeInTheDocument();
  });

  it("calls onSelect with the workspace id on click", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onSelect = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={onSelect}
        onCustomize={vi.fn()}
        onNewWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("B"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("calls onCustomize with the workspace id on right-click when no onContextMenu provided", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onCustomize = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        onCustomize={onCustomize}
        onNewWorkspace={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"));
    expect(onCustomize).toHaveBeenCalledWith("a");
  });

  it("calls onContextMenu with workspace id and coords on right-click when provided", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onContextMenu = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
        onNewWorkspace={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"), { clientX: 50, clientY: 80 });
    expect(onContextMenu).toHaveBeenCalledWith("a", 50, 80);
  });

  it("calls onNewWorkspace when the + button is clicked", () => {
    const onNewWorkspace = vi.fn();
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces: [] },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId={null}
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onNewWorkspace={onNewWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(onNewWorkspace).toHaveBeenCalled();
  });
});

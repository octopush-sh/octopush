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
    linkedIssueKey: null,
    issueLinkDismissed: false,
    ...overrides,
  };
}

describe("WorkspaceRail", () => {
  it("renders one button per workspace", () => {
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
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(workspaces.length);
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
        isCollapsed={false}
        onCustomize={vi.fn()}
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
        isCollapsed={false}
        onCustomize={vi.fn()}
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
        isCollapsed={false}
        onCustomize={onCustomize}
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
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"), { clientX: 50, clientY: 80 });
    expect(onContextMenu).toHaveBeenCalledWith("a", 50, 80);
  });

  it("renders at the expanded width when isCollapsed=false and the collapsed width when isCollapsed=true", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { container, rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const aside = container.querySelector("aside");
    expect(aside).toHaveClass("w-[280px]");

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );
    expect(aside).toHaveClass("w-[50px]");
  });

  it("should render project headers in expanded mode", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Frontend", workspaces: [workspaces[0]] },
      { id: "proj-2", name: "Backend", workspaces: [workspaces[1]] },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    // Check that project headers are visible
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();

    // Check that they have correct classes (the wrapper div carries font-mono, uppercase, and style)
    const frontendHeader = screen.getByText("Frontend").closest("div[style]");
    expect(frontendHeader).toHaveClass("font-mono");
    expect(frontendHeader).toHaveClass("uppercase");
    expect(frontendHeader?.getAttribute("style")).toBeTruthy();
  });

  it("should hide project headers when collapsed", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Frontend", workspaces: [workspaces[0]] },
      { id: "proj-2", name: "Backend", workspaces: [workspaces[1]] },
    ];
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.queryByText("Frontend")).not.toBeInTheDocument();
    expect(screen.queryByText("Backend")).not.toBeInTheDocument();
  });

  it("should show monograms in both expanded and collapsed modes", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Hyperion" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { container, rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    // Monogram should be visible in expanded mode
    const monogram = screen.getByText("H");
    expect(monogram).toBeInTheDocument();

    // Find the expanded monogram button (24px)
    let monogramButtons = container.querySelectorAll("button");
    let expandedMonogramFound = false;
    monogramButtons.forEach((button) => {
      if (button.textContent === "H" && button.classList.contains("h-6")) {
        expect(button).toHaveClass("w-6"); // 24px = h-6 w-6
        expandedMonogramFound = true;
      }
    });
    expect(expandedMonogramFound).toBe(true);

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    // Monogram should still be visible in collapsed mode
    expect(screen.getByText("H")).toBeInTheDocument();

    // Find the collapsed monogram button (28px)
    monogramButtons = container.querySelectorAll("button");
    let collapsedMonogramFound = false;
    monogramButtons.forEach((button) => {
      if (button.textContent === "H" && button.classList.contains("h-7")) {
        expect(button).toHaveClass("w-7"); // 28px = h-7 w-7
        collapsedMonogramFound = true;
      }
    });
    expect(collapsedMonogramFound).toBe(true);
  });

  it("should render workspace names only in expanded mode", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    // Workspace name should be visible in expanded mode
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    // In collapsed mode, the workspace name is only shown in the title attribute (tooltip)
    // Find the monogram button and check it has the title attribute
    const monogramButton = screen.getByTitle("Alpha");
    expect(monogramButton).toBeInTheDocument();
    expect(monogramButton).toHaveAttribute("title", "Alpha");
  });

  it("should display active state with correct styling", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { container } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    // Find the expanded row for the active workspace
    const rows = container.querySelectorAll(".group");
    expect(rows.length).toBeGreaterThan(0);

    // At least one row should have the active styling (border-octo-brass)
    let activeRowFound = false;
    rows.forEach((row) => {
      if (row.classList.contains("border-octo-brass")) {
        activeRowFound = true;
      }
    });
    expect(activeRowFound).toBe(true);
  });
});

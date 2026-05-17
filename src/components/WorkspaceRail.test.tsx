import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceRail } from "./WorkspaceRail";
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
  it("renders one button per workspace plus a 'new workspace' button", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
      makeWorkspace({ id: "c", name: "Gamma" }),
    ];
    render(
      <WorkspaceRail
        workspaces={workspaces}
        activeId="a"
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onNewWorkspace={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(workspaces.length + 1);
  });

  it("renders the workspace monogram glyph", () => {
    const workspaces = [makeWorkspace({ name: "Hyperion" })];
    render(
      <WorkspaceRail
        workspaces={workspaces}
        activeId="ws-1"
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
    const onSelect = vi.fn();
    render(
      <WorkspaceRail
        workspaces={workspaces}
        activeId="a"
        onSelect={onSelect}
        onCustomize={vi.fn()}
        onNewWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("B"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("calls onCustomize with the workspace id on right-click", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const onCustomize = vi.fn();
    render(
      <WorkspaceRail
        workspaces={workspaces}
        activeId="a"
        onSelect={vi.fn()}
        onCustomize={onCustomize}
        onNewWorkspace={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"));
    expect(onCustomize).toHaveBeenCalledWith("a");
  });

  it("calls onNewWorkspace when the + button is clicked", () => {
    const onNewWorkspace = vi.fn();
    render(
      <WorkspaceRail
        workspaces={[]}
        activeId={null}
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        onNewWorkspace={onNewWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(onNewWorkspace).toHaveBeenCalled();
  });
});

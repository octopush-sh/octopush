import { describe, it, expect, vi, beforeEach } from "vitest";
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
    fromBranch: null,
    ...overrides,
  };
}

describe("WorkspaceRail - Context Menu - EXHAUSTIVE", () => {
  describe("Single Project with Multiple Workspaces", () => {
    const onContextMenu = vi.fn();
    const onCustomize = vi.fn();
    const onSelect = vi.fn();

    beforeEach(() => {
      onContextMenu.mockClear();
      onCustomize.mockClear();
      onSelect.mockClear();
    });

    it("REQUIREMENT: Right-click on 1st workspace triggers onContextMenu with correct ID", async () => {
      const workspaces = [
        makeWorkspace({ id: "ws-alpha", name: "Alpha" }),
        makeWorkspace({ id: "ws-beta", name: "Beta" }),
        makeWorkspace({ id: "ws-gamma", name: "Gamma" }),
      ];
      const projects: ProjectGroup[] = [
        { id: "proj-1", name: "Project 1", workspaces },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-alpha"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      // Find button by its aria-label which includes workspace name
      const alphaBtnByLabel = screen.getByLabelText(/Alpha/);
      expect(alphaBtnByLabel).toBeDefined();

      fireEvent.contextMenu(alphaBtnByLabel, { clientX: 100, clientY: 200 });

      // MUST be called with EXACTLY this workspace ID
      expect(onContextMenu).toHaveBeenCalledWith("ws-alpha", 100, 200);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Right-click on 2nd workspace triggers onContextMenu with correct ID", async () => {
      const workspaces = [
        makeWorkspace({ id: "ws-alpha", name: "Alpha" }),
        makeWorkspace({ id: "ws-beta", name: "Beta" }),
        makeWorkspace({ id: "ws-gamma", name: "Gamma" }),
      ];
      const projects: ProjectGroup[] = [
        { id: "proj-1", name: "Project 1", workspaces },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-beta"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const betaBtnByLabel = screen.getByLabelText(/Beta/);
      fireEvent.contextMenu(betaBtnByLabel, { clientX: 150, clientY: 250 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-beta", 150, 250);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Right-click on 3rd workspace triggers onContextMenu with correct ID", async () => {
      const workspaces = [
        makeWorkspace({ id: "ws-alpha", name: "Alpha" }),
        makeWorkspace({ id: "ws-beta", name: "Beta" }),
        makeWorkspace({ id: "ws-gamma", name: "Gamma" }),
      ];
      const projects: ProjectGroup[] = [
        { id: "proj-1", name: "Project 1", workspaces },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-gamma"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const gammaBtnByLabel = screen.getByLabelText(/Gamma/);
      fireEvent.contextMenu(gammaBtnByLabel, { clientX: 200, clientY: 300 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-gamma", 200, 300);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Each workspace's right-click is independent", async () => {
      const workspaces = [
        makeWorkspace({ id: "ws-alpha", name: "Alpha" }),
        makeWorkspace({ id: "ws-beta", name: "Beta" }),
      ];
      const projects: ProjectGroup[] = [
        { id: "proj-1", name: "Project 1", workspaces },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-alpha"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      // Right-click alpha
      fireEvent.contextMenu(screen.getByLabelText(/Alpha/), { clientX: 10, clientY: 20 });
      expect(onContextMenu).toHaveBeenNthCalledWith(1, "ws-alpha", 10, 20);

      // Right-click beta
      fireEvent.contextMenu(screen.getByLabelText(/Beta/), { clientX: 30, clientY: 40 });
      expect(onContextMenu).toHaveBeenNthCalledWith(2, "ws-beta", 30, 40);

      expect(onContextMenu).toHaveBeenCalledTimes(2);
    });
  });

  describe("Multiple Projects with Multiple Workspaces Each", () => {
    const onContextMenu = vi.fn();
    const onCustomize = vi.fn();
    const onSelect = vi.fn();

    beforeEach(() => {
      onContextMenu.mockClear();
      onCustomize.mockClear();
      onSelect.mockClear();
    });

    it("REQUIREMENT: Right-click 1st workspace of PROJECT 1", async () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [
            makeWorkspace({ id: "ws-1a", name: "WS-1-A" }),
            makeWorkspace({ id: "ws-1b", name: "WS-1-B" }),
          ],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [
            makeWorkspace({ id: "ws-2a", name: "WS-2-A" }),
            makeWorkspace({ id: "ws-2b", name: "WS-2-B" }),
          ],
        },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-1a"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const ws1aBtn = screen.getByLabelText(/WS-1-A/);
      fireEvent.contextMenu(ws1aBtn, { clientX: 100, clientY: 100 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-1a", 100, 100);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Right-click 2nd workspace of PROJECT 1", async () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [
            makeWorkspace({ id: "ws-1a", name: "WS-1-A" }),
            makeWorkspace({ id: "ws-1b", name: "WS-1-B" }),
          ],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [
            makeWorkspace({ id: "ws-2a", name: "WS-2-A" }),
            makeWorkspace({ id: "ws-2b", name: "WS-2-B" }),
          ],
        },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-1b"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const ws1bBtn = screen.getByLabelText(/WS-1-B/);
      fireEvent.contextMenu(ws1bBtn, { clientX: 110, clientY: 110 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-1b", 110, 110);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Right-click 1st workspace of PROJECT 2", async () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [
            makeWorkspace({ id: "ws-1a", name: "WS-1-A" }),
            makeWorkspace({ id: "ws-1b", name: "WS-1-B" }),
          ],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [
            makeWorkspace({ id: "ws-2a", name: "WS-2-A" }),
            makeWorkspace({ id: "ws-2b", name: "WS-2-B" }),
          ],
        },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-2a"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const ws2aBtn = screen.getByLabelText(/WS-2-A/);
      fireEvent.contextMenu(ws2aBtn, { clientX: 200, clientY: 200 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-2a", 200, 200);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: Right-click 2nd workspace of PROJECT 2", async () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [
            makeWorkspace({ id: "ws-1a", name: "WS-1-A" }),
            makeWorkspace({ id: "ws-1b", name: "WS-1-B" }),
          ],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [
            makeWorkspace({ id: "ws-2a", name: "WS-2-A" }),
            makeWorkspace({ id: "ws-2b", name: "WS-2-B" }),
          ],
        },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-2b"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      const ws2bBtn = screen.getByLabelText(/WS-2-B/);
      fireEvent.contextMenu(ws2bBtn, { clientX: 210, clientY: 210 });

      expect(onContextMenu).toHaveBeenCalledWith("ws-2b", 210, 210);
      expect(onContextMenu).toHaveBeenCalledTimes(1);
    });

    it("REQUIREMENT: All 4 workspaces (2 projects x 2 workspaces) work independently", async () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [
            makeWorkspace({ id: "ws-1a", name: "WS-1-A" }),
            makeWorkspace({ id: "ws-1b", name: "WS-1-B" }),
          ],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [
            makeWorkspace({ id: "ws-2a", name: "WS-2-A" }),
            makeWorkspace({ id: "ws-2b", name: "WS-2-B" }),
          ],
        },
      ];

      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-1a"
          onSelect={onSelect}
          isCollapsed={false}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
        />,
      );

      // Right-click all 4 workspaces
      fireEvent.contextMenu(screen.getByLabelText(/WS-1-A/), { clientX: 11, clientY: 11 });
      fireEvent.contextMenu(screen.getByLabelText(/WS-1-B/), { clientX: 12, clientY: 12 });
      fireEvent.contextMenu(screen.getByLabelText(/WS-2-A/), { clientX: 21, clientY: 21 });
      fireEvent.contextMenu(screen.getByLabelText(/WS-2-B/), { clientX: 22, clientY: 22 });

      expect(onContextMenu).toHaveBeenNthCalledWith(1, "ws-1a", 11, 11);
      expect(onContextMenu).toHaveBeenNthCalledWith(2, "ws-1b", 12, 12);
      expect(onContextMenu).toHaveBeenNthCalledWith(3, "ws-2a", 21, 21);
      expect(onContextMenu).toHaveBeenNthCalledWith(4, "ws-2b", 22, 22);

      expect(onContextMenu).toHaveBeenCalledTimes(4);
    });
  });

  describe("Project Context Menu", () => {
    const onProjectContextMenu = vi.fn();

    beforeEach(() => {
      onProjectContextMenu.mockClear();
    });

    it("REQUIREMENT: Right-click on PROJECT 1 header", () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [makeWorkspace({ id: "ws-1" })],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [makeWorkspace({ id: "ws-2" })],
        },
      ];

      const { container } = render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-1"
          onSelect={vi.fn()}
          isCollapsed={false}
          onCustomize={vi.fn()}
          onProjectContextMenu={onProjectContextMenu}
        />,
      );

      const projectHeader = Array.from(container.querySelectorAll("div")).find(
        (div) => div.textContent.includes("Frontend") && div.className.includes("font-mono")
      );

      expect(projectHeader).toBeDefined();
      fireEvent.contextMenu(projectHeader!, { clientX: 100, clientY: 100 });

      expect(onProjectContextMenu).toHaveBeenCalledWith("proj-1", 100, 100);
    });

    it("REQUIREMENT: Right-click on PROJECT 2 header", () => {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [makeWorkspace({ id: "ws-1" })],
        },
        {
          id: "proj-2",
          name: "Backend",
          workspaces: [makeWorkspace({ id: "ws-2" })],
        },
      ];

      const { container } = render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="ws-2"
          onSelect={vi.fn()}
          isCollapsed={false}
          onCustomize={vi.fn()}
          onProjectContextMenu={onProjectContextMenu}
        />,
      );

      const projectHeader = Array.from(container.querySelectorAll("div")).find(
        (div) => div.textContent.includes("Backend") && div.className.includes("font-mono")
      );

      expect(projectHeader).toBeDefined();
      fireEvent.contextMenu(projectHeader!, { clientX: 200, clientY: 200 });

      expect(onProjectContextMenu).toHaveBeenCalledWith("proj-2", 200, 200);
    });
  });
});

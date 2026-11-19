import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectContextMenu } from "./ProjectContextMenu";

describe("ProjectContextMenu", () => {
  const baseProps = {
    projectId: "project-123",
    projectName: "My Project",
    x: 100,
    y: 200,
    onRevealInFinder: vi.fn(),
    onCopyPath: vi.fn(),
    onOpenInEditor: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onRename: vi.fn(),
    onChangeTint: vi.fn(),
    onViewArchived: vi.fn(),
    pinned: false,
    canMoveUp: true,
    canMoveDown: true,
    onTogglePin: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onDismiss: vi.fn(),
  };

  it("renders the project name header and reach-on-disk actions", () => {
    render(<ProjectContextMenu {...baseProps} />);
    expect(screen.getByText("My Project")).toBeInTheDocument();
    expect(screen.getByText(/Reveal in Finder/)).toBeInTheDocument();
    expect(screen.getByText(/Copy path/)).toBeInTheDocument();
    expect(screen.getByText(/Open in editor/)).toBeInTheDocument();
    expect(screen.getByText(/Open in terminal/)).toBeInTheDocument();
    expect(screen.getByText(/Rename project/)).toBeInTheDocument();
    expect(screen.getByText(/Change tint/)).toBeInTheDocument();
    expect(screen.getByText("Close project")).toBeInTheDocument();
    expect(screen.getByText(/Delete from disk/)).toBeInTheDocument();
  });

  it("does not render the dropped 'coming soon' stub items", () => {
    render(<ProjectContextMenu {...baseProps} />);
    expect(screen.queryByText(/Project settings/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default agent model/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tool permissions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Workspace presets/)).not.toBeInTheDocument();
  });

  it("calls onRevealInFinder and onDismiss when Reveal in Finder is clicked", () => {
    const onRevealInFinder = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onRevealInFinder={onRevealInFinder}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Reveal in Finder/));
    expect(onRevealInFinder).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onCopyPath and onDismiss when Copy path is clicked", () => {
    const onCopyPath = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu {...baseProps} onCopyPath={onCopyPath} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByText(/Copy path/));
    expect(onCopyPath).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onOpenInEditor and onDismiss when Open in editor is clicked", () => {
    const onOpenInEditor = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onOpenInEditor={onOpenInEditor}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Open in editor/));
    expect(onOpenInEditor).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onOpenInTerminal and onDismiss when Open in terminal is clicked", () => {
    const onOpenInTerminal = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onOpenInTerminal={onOpenInTerminal}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Open in terminal/));
    expect(onOpenInTerminal).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onRename and onDismiss when Rename is clicked", () => {
    const onRename = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu {...baseProps} onRename={onRename} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByText(/Rename project/));
    expect(onRename).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onChangeTint and onDismiss when Change tint is clicked", () => {
    const onChangeTint = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onChangeTint={onChangeTint}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Change tint/));
    expect(onChangeTint).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onClose and onDismiss when Close project is clicked", () => {
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu {...baseProps} onClose={onClose} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByText("Close project"));
    expect(onClose).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onDelete and onDismiss when Delete from disk is clicked", () => {
    const onDelete = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu {...baseProps} onDelete={onDelete} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByText(/Delete from disk/));
    expect(onDelete).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onDismiss on Escape key", () => {
    const onDismiss = vi.fn();
    render(<ProjectContextMenu {...baseProps} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onDismiss when clicking outside the menu", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ProjectContextMenu {...baseProps} onDismiss={onDismiss} />,
    );
    // Click on the document body, outside the menu
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
    // Cleanup
    container.remove();
  });

  it("renders Set Jira project key item and calls onSetJiraProjectKey when clicked", () => {
    const onSetJiraProjectKey = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onSetJiraProjectKey={onSetJiraProjectKey}
        onDismiss={onDismiss}
      />,
    );
    const item = screen.getByText(/Set Jira project key/);
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onSetJiraProjectKey).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does not render Set Jira project key item when prop is not provided", () => {
    render(<ProjectContextMenu {...baseProps} />);
    expect(screen.queryByText(/Set Jira project key/)).not.toBeInTheDocument();
  });

  it("offers New mission group only when wired, runs it and dismisses", () => {
    const { unmount } = render(<ProjectContextMenu {...baseProps} />);
    expect(screen.queryByRole("menuitem", { name: "New mission group" })).toBeNull();
    unmount();
    const onNewGroup = vi.fn();
    const onDismiss = vi.fn();
    render(<ProjectContextMenu {...baseProps} onNewGroup={onNewGroup} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "New mission group" }));
    expect(onNewGroup).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe("Move to group (project groups)", () => {
    const GROUPS = [
      { id: "g-client", name: "Client work", tint: "verdigris" as const },
      { id: "g-side", name: "Side projects", tint: null },
    ];
    const openSubmenu = () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Move to group/ }));
      return screen.getByRole("menu", { name: "Move to group" });
    };

    it("is drawn only when the move and the new-group flows are wired", () => {
      render(<ProjectContextMenu {...baseProps} />);
      expect(screen.queryByRole("menuitem", { name: /Move to group/ })).toBeNull();
    });

    it("lists the project groups with the current one checked, and moves the project", () => {
      const onMoveToGroup = vi.fn();
      const onDismiss = vi.fn();
      render(
        <ProjectContextMenu
          {...baseProps}
          projectGroups={GROUPS}
          projectGroupId="g-client"
          onMoveToGroup={onMoveToGroup}
          onNewProjectGroup={vi.fn()}
          onRemoveFromGroup={vi.fn()}
          onDismiss={onDismiss}
        />,
      );
      const submenu = openSubmenu();
      const rows = submenu.querySelectorAll('[role="menuitemradio"]');
      expect([...rows].map((r) => r.textContent)).toEqual(["Client work", "Side projects"]);
      expect(rows[0]).toHaveAttribute("aria-checked", "true");
      fireEvent.click(rows[1]);
      expect(onMoveToGroup).toHaveBeenCalledWith("g-side");
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("New group… and Remove from group run and dismiss; a loose project gets no Remove", () => {
      const onNewProjectGroup = vi.fn();
      const onRemoveFromGroup = vi.fn();
      const props = {
        ...baseProps,
        projectGroups: GROUPS,
        onMoveToGroup: vi.fn(),
        onNewProjectGroup,
        onRemoveFromGroup,
      };
      const first = render(<ProjectContextMenu {...props} projectGroupId={null} />);
      const loose = openSubmenu();
      expect(loose.textContent).not.toContain("Remove from group");
      fireEvent.click(screen.getByRole("menuitem", { name: /New group…/ }));
      expect(onNewProjectGroup).toHaveBeenCalledTimes(1);
      first.unmount();

      render(<ProjectContextMenu {...props} projectGroupId="g-side" />);
      openSubmenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from group" }));
      expect(onRemoveFromGroup).toHaveBeenCalledTimes(1);
    });

    it("keeps the mission-group item apart: by name, and a block away with the project's missions", () => {
      render(
        <ProjectContextMenu
          {...baseProps}
          onNewGroup={vi.fn()}
          projectGroups={GROUPS}
          onMoveToGroup={vi.fn()}
          onNewProjectGroup={vi.fn()}
        />,
      );
      // No row of the project's own menu reads plain "New group": that phrase
      // belongs to "Move to group", which groups the project itself.
      const rows = Array.from(
        screen.getByRole("menu", { name: "Project actions" }).querySelectorAll<HTMLElement>(":scope > *"),
      ).map((el) => (el.querySelector('[role="menuitem"]') ?? el).textContent?.trim() || "—");
      expect(rows).not.toContain("New group");
      const at = (label: string) => rows.findIndex((row) => row.startsWith(label));
      // Move to group leads the block that places the project in the rail…
      expect(at("Move to group")).toBe(at("Pin to top") - 1);
      // …and the mission group is made in the missions block, past a separator.
      expect(at("New mission group")).toBe(at("Archived workspaces") - 1);
      expect(at("New mission group")).toBeGreaterThan(at("Move down"));
      expect(rows.slice(at("Move to group"), at("New mission group"))).toContain("—");
    });
  });
});

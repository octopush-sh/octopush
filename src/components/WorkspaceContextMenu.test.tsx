import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";

describe("WorkspaceContextMenu", () => {
  const baseProps = {
    x: 100,
    y: 200,
    workspaceName: "Alpha",
    isMain: false,
    onRevealInFinder: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyBranch: vi.fn(),
    onOpenInEditor: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onCustomize: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders reach-on-disk, Customize, and Delete rows", () => {
    render(<WorkspaceContextMenu {...baseProps} />);
    expect(screen.getByText(/Reveal in Finder/)).toBeInTheDocument();
    expect(screen.getByText(/Copy path/)).toBeInTheDocument();
    expect(screen.getByText(/Copy branch name/)).toBeInTheDocument();
    expect(screen.getByText(/Open in editor/)).toBeInTheDocument();
    expect(screen.getByText(/Open in terminal/)).toBeInTheDocument();
    expect(screen.getByText(/Customize/)).toBeInTheDocument();
    expect(screen.getByText(/Delete workspace/)).toBeInTheDocument();
  });

  it("calls reach-on-disk handlers and onClose when clicked", () => {
    const onRevealInFinder = vi.fn();
    const onCopyPath = vi.fn();
    const onCopyBranch = vi.fn();
    const onOpenInEditor = vi.fn();
    const onOpenInTerminal = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceContextMenu
        {...baseProps}
        onRevealInFinder={onRevealInFinder}
        onCopyPath={onCopyPath}
        onCopyBranch={onCopyBranch}
        onOpenInEditor={onOpenInEditor}
        onOpenInTerminal={onOpenInTerminal}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/Reveal in Finder/));
    expect(onRevealInFinder).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Copy path/));
    expect(onCopyPath).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Copy branch name/));
    expect(onCopyBranch).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Open in editor/));
    expect(onOpenInEditor).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Open in terminal/));
    expect(onOpenInTerminal).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(5);
  });

  it("calls onDelete and onClose when Delete row is clicked", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceContextMenu
        {...baseProps}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/Delete workspace/));
    expect(onDelete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("hides Delete for the main workspace (C6)", () => {
    render(<WorkspaceContextMenu {...baseProps} isMain />);
    expect(screen.queryByText(/Delete workspace/)).not.toBeInTheDocument();
  });

  it("renders the ticket key in the header when provided", () => {
    render(<WorkspaceContextMenu {...baseProps} ticketKey="PROJ-7" />);
    expect(screen.getByText(/PROJ-7/)).toBeInTheDocument();
  });

  it("calls onCustomize and onClose when Customize row is clicked", () => {
    const onCustomize = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceContextMenu
        {...baseProps}
        onCustomize={onCustomize}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/Customize/));
    expect(onCustomize).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<WorkspaceContextMenu {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking outside the menu", () => {
    const onClose = vi.fn();
    const { container } = render(
      <WorkspaceContextMenu {...baseProps} onClose={onClose} />,
    );
    // Click on the document body, outside the menu
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
    // Cleanup
    container.remove();
  });

  describe("Jira linkage items", () => {
    it("linkageKind=unlinked: shows Link Jira ticket only (no Skip)", () => {
      const onLinkJira = vi.fn();
      render(
        <WorkspaceContextMenu
          {...baseProps}
          linkageKind="unlinked"
          onLinkJira={onLinkJira}
          onChangeJira={vi.fn()}
          onUnlinkJira={vi.fn()}
        />,
      );
      expect(screen.getByText(/Link Jira ticket/)).toBeInTheDocument();
      expect(screen.queryByText(/Change Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Unlink Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Skip Jira here/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByText(/Link Jira ticket/));
      expect(onLinkJira).toHaveBeenCalled();
    });

    it("linkageKind=linked: shows Change + Unlink Jira ticket items (no Skip)", () => {
      const onChangeJira = vi.fn();
      const onUnlinkJira = vi.fn();
      render(
        <WorkspaceContextMenu
          {...baseProps}
          linkageKind="linked"
          onLinkJira={vi.fn()}
          onChangeJira={onChangeJira}
          onUnlinkJira={onUnlinkJira}
        />,
      );
      expect(screen.queryByText(/Link Jira ticket/)).not.toBeInTheDocument();
      expect(screen.getByText(/Change Jira ticket/)).toBeInTheDocument();
      expect(screen.getByText(/Unlink Jira ticket/)).toBeInTheDocument();
      expect(screen.queryByText(/Skip Jira here/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByText(/Change Jira ticket/));
      expect(onChangeJira).toHaveBeenCalled();

      fireEvent.click(screen.getByText(/Unlink Jira ticket/));
      expect(onUnlinkJira).toHaveBeenCalled();
    });

    it("no Jira items rendered when linkageKind is not provided", () => {
      render(<WorkspaceContextMenu {...baseProps} />);
      expect(screen.queryByText(/Link Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Change Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Skip Jira here/)).not.toBeInTheDocument();
    });
  });

  describe("Move to group", () => {
    const groups = [
      { id: "g1", name: "Vulnerability fixes", tint: "rouge" as const },
      { id: "g2", name: "PR reviews", tint: null },
    ];
    const groupProps = { groups, onMoveToGroup: vi.fn(), onNewGroup: vi.fn(), onRemoveFromGroup: vi.fn() };
    const row = () => screen.getByRole("menuitem", { name: "Move to group" });
    const submenu = () => screen.getByRole("menu", { name: "Move to group" });

    it("is absent until the group actions are wired", () => {
      render(<WorkspaceContextMenu {...baseProps} />);
      expect(screen.queryByRole("menuitem", { name: "Move to group" })).toBeNull();
    });

    it("opens a submenu listing the project's groups, the current one checked", () => {
      render(<WorkspaceContextMenu {...baseProps} {...groupProps} groupId="g2" />);
      expect(row()).toHaveAttribute("aria-haspopup", "menu");
      expect(row()).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(row());
      expect(row()).toHaveAttribute("aria-expanded", "true");
      const items = within(submenu()).getAllByRole("menuitemradio");
      expect(items.map((i) => i.textContent)).toEqual(["Vulnerability fixes", "PR reviews"]);
      expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      // Opened from the keyboard or a click, the checked group has the focus.
      expect(items[1]).toHaveFocus();
      expect(within(submenu()).getByRole("menuitem", { name: /New group…/ })).toBeInTheDocument();
      expect(within(submenu()).getByRole("menuitem", { name: "Remove from group" })).toBeInTheDocument();
      // The submenu lives inside the menu, so a click in it is not an outside click.
      expect(screen.getByRole("menu", { name: "Workspace actions" })).toContainElement(submenu());
    });

    it("moves, creates and removes, closing the menu each time", () => {
      const onMoveToGroup = vi.fn();
      const onNewGroup = vi.fn();
      const onRemoveFromGroup = vi.fn();
      const onClose = vi.fn();
      const props = { ...baseProps, ...groupProps, onMoveToGroup, onNewGroup, onRemoveFromGroup, onClose, groupId: "g1" };
      render(<WorkspaceContextMenu {...props} />);
      fireEvent.click(row());
      fireEvent.click(within(submenu()).getByRole("menuitemradio", { name: "PR reviews" }));
      expect(onMoveToGroup).toHaveBeenCalledWith("g2");
      fireEvent.click(within(submenu()).getByRole("menuitem", { name: /New group…/ }));
      expect(onNewGroup).toHaveBeenCalledTimes(1);
      fireEvent.click(within(submenu()).getByRole("menuitem", { name: "Remove from group" }));
      expect(onRemoveFromGroup).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it("a loose mission gets no Remove from group; a project with no group still offers New group…", () => {
      render(<WorkspaceContextMenu {...baseProps} {...groupProps} groups={[]} groupId={null} />);
      fireEvent.click(row());
      expect(within(submenu()).queryByRole("menuitemradio")).toBeNull();
      expect(within(submenu()).queryByRole("menuitem", { name: "Remove from group" })).toBeNull();
      expect(within(submenu()).getByRole("menuitem", { name: /New group…/ })).toHaveFocus();
    });

    it("→ opens it, ↑/↓ walk the submenu alone, ← returns to the row", () => {
      render(<WorkspaceContextMenu {...baseProps} {...groupProps} groupId={null} />);
      row().focus();
      fireEvent.keyDown(row(), { key: "ArrowRight" });
      const items = within(submenu()).getAllByRole("menuitemradio");
      expect(items[0]).toHaveFocus();
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(items[1]).toHaveFocus();
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(within(submenu()).getByRole("menuitem", { name: /New group…/ })).toHaveFocus();
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(items[0]).toHaveFocus(); // wraps inside the submenu, never into the parent
      fireEvent.keyDown(items[0], { key: "ArrowLeft" });
      expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
      expect(row()).toHaveFocus();
      // The parent's walk skips nothing and never enters a closed submenu.
      fireEvent.keyDown(window, { key: "ArrowUp" });
      expect(screen.getByRole("menuitem", { name: /Customize/ })).toHaveFocus();
    });

    it("opens on hover and closes shortly after the pointer leaves", () => {
      vi.useFakeTimers();
      try {
        render(<WorkspaceContextMenu {...baseProps} {...groupProps} />);
        fireEvent.mouseEnter(row().parentElement!);
        expect(submenu()).toBeInTheDocument();
        fireEvent.mouseLeave(row().parentElement!);
        expect(submenu()).toBeInTheDocument(); // a grace window to cross the gap
        act(() => {
          vi.advanceTimersByTime(200);
        });
        expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
});

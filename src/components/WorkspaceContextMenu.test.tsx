import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";

describe("WorkspaceContextMenu", () => {
  const baseProps = {
    x: 100,
    y: 200,
    workspaceName: "Alpha",
    onCustomize: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders Customize and Delete rows", () => {
    render(<WorkspaceContextMenu {...baseProps} />);
    expect(screen.getByText(/Customize/)).toBeInTheDocument();
    expect(screen.getByText(/Delete workspace/)).toBeInTheDocument();
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
    it("linkageKind=unlinked: shows Link Jira ticket and Skip Jira here", () => {
      const onLinkJira = vi.fn();
      const onSkipJira = vi.fn();
      render(
        <WorkspaceContextMenu
          {...baseProps}
          linkageKind="unlinked"
          onLinkJira={onLinkJira}
          onChangeJira={vi.fn()}
          onUnlinkJira={vi.fn()}
          onSkipJira={onSkipJira}
        />,
      );
      expect(screen.getByText(/Link Jira ticket/)).toBeInTheDocument();
      expect(screen.queryByText(/Change Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Unlink Jira ticket/)).not.toBeInTheDocument();
      expect(screen.getByText(/Skip Jira here/)).toBeInTheDocument();

      fireEvent.click(screen.getByText(/Link Jira ticket/));
      expect(onLinkJira).toHaveBeenCalled();
    });

    it("linkageKind=linked: shows Change + Unlink Jira ticket items", () => {
      const onChangeJira = vi.fn();
      const onUnlinkJira = vi.fn();
      render(
        <WorkspaceContextMenu
          {...baseProps}
          linkageKind="linked"
          onLinkJira={vi.fn()}
          onChangeJira={onChangeJira}
          onUnlinkJira={onUnlinkJira}
          onSkipJira={vi.fn()}
        />,
      );
      expect(screen.queryByText(/Link Jira ticket/)).not.toBeInTheDocument();
      expect(screen.getByText(/Change Jira ticket/)).toBeInTheDocument();
      expect(screen.getByText(/Unlink Jira ticket/)).toBeInTheDocument();
      expect(screen.getByText(/Skip Jira here/)).toBeInTheDocument();

      fireEvent.click(screen.getByText(/Change Jira ticket/));
      expect(onChangeJira).toHaveBeenCalled();

      fireEvent.click(screen.getByText(/Unlink Jira ticket/));
      expect(onUnlinkJira).toHaveBeenCalled();
    });

    it("linkageKind=dismissed: shows Link Jira ticket but not Skip Jira here", () => {
      const onLinkJira = vi.fn();
      render(
        <WorkspaceContextMenu
          {...baseProps}
          linkageKind="dismissed"
          onLinkJira={onLinkJira}
          onChangeJira={vi.fn()}
          onUnlinkJira={vi.fn()}
          onSkipJira={vi.fn()}
        />,
      );
      expect(screen.getByText(/Link Jira ticket/)).toBeInTheDocument();
      // Skip Jira here is hidden when already dismissed
      expect(screen.queryByText(/Skip Jira here/)).not.toBeInTheDocument();
    });

    it("no Jira items rendered when linkageKind is not provided", () => {
      render(<WorkspaceContextMenu {...baseProps} />);
      expect(screen.queryByText(/Link Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Change Jira ticket/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Skip Jira here/)).not.toBeInTheDocument();
    });
  });
});

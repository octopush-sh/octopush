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
});

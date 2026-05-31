import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectContextMenu } from "./ProjectContextMenu";

describe("ProjectContextMenu", () => {
  const baseProps = {
    projectId: "project-123",
    projectName: "My Project",
    x: 100,
    y: 200,
    onRename: vi.fn(),
    onChangeTint: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onDismiss: vi.fn(),
  };

  it("renders all menu items (active and disabled)", () => {
    render(<ProjectContextMenu {...baseProps} />);
    expect(screen.getByText(/Rename project/)).toBeInTheDocument();
    expect(screen.getByText(/Change tint/)).toBeInTheDocument();
    expect(screen.getByText(/Project settings/)).toBeInTheDocument();
    expect(screen.getByText(/Default agent model/)).toBeInTheDocument();
    expect(screen.getByText(/Tool permissions/)).toBeInTheDocument();
    expect(screen.getByText(/Workspace presets/)).toBeInTheDocument();
    expect(screen.getByText(/Close project/)).toBeInTheDocument();
    expect(screen.getByText(/Delete project from disk/)).toBeInTheDocument();
  });

  it("disabled items have 'Coming soon' title", () => {
    render(<ProjectContextMenu {...baseProps} />);
    const projectSettingsBtn = screen.getByText(/Project settings/);
    const agentModelBtn = screen.getByText(/Default agent model/);
    const toolPermissionsBtn = screen.getByText(/Tool permissions/);
    const presetsBtn = screen.getByText(/Workspace presets/);

    expect(projectSettingsBtn).toHaveAttribute("title", "Coming soon");
    expect(agentModelBtn).toHaveAttribute("title", "Coming soon");
    expect(toolPermissionsBtn).toHaveAttribute("title", "Coming soon");
    expect(presetsBtn).toHaveAttribute("title", "Coming soon");
  });

  it("calls onRename and onDismiss when Rename is clicked", () => {
    const onRename = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onRename={onRename}
        onDismiss={onDismiss}
      />,
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
      <ProjectContextMenu
        {...baseProps}
        onClose={onClose}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Close project/));
    expect(onClose).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("calls onDelete and onDismiss when Delete is clicked", () => {
    const onDelete = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ProjectContextMenu
        {...baseProps}
        onDelete={onDelete}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Delete project from disk/));
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

  it("calls onDismiss on mouseLeave", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ProjectContextMenu {...baseProps} onDismiss={onDismiss} />,
    );
    const menu = container.querySelector("[role='menu']");
    if (menu) {
      fireEvent.mouseLeave(menu);
      expect(onDismiss).toHaveBeenCalled();
    }
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

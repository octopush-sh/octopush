import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextHeader } from "./ContextHeader";

const baseProps = {
  projectName: "octopus-sh",
  onOpenProjectSwitcher: vi.fn(),
};

describe("ContextHeader", () => {
  it("renders the workspace name", () => {
    render(
      <ContextHeader
        {...baseProps}
        workspaceName="auth-refactor"
        branch="feat/auth"
        gitStatus={null}
      />,
    );
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
  });

  it("renders the branch", () => {
    render(
      <ContextHeader {...baseProps} workspaceName="X" branch="feat/auth" gitStatus={null} />,
    );
    expect(screen.getByText(/feat\/auth/)).toBeInTheDocument();
  });

  it("renders the unstaged count when git status is provided", () => {
    render(
      <ContextHeader
        {...baseProps}
        workspaceName="X"
        branch="main"
        gitStatus={{
          branch: "main",
          changedFiles: [
            { path: "a.ts", status: "modified", staged: false, unstaged: true },
            { path: "b.ts", status: "new", staged: false, unstaged: true },
          ],
          ahead: 0,
          behind: 0, hasUpstream: false,
        }}
      />,
    );
    expect(screen.getByText(/2 unstaged/)).toBeInTheDocument();
  });

  it("does not render the unstaged count when changedFiles is empty", () => {
    render(
      <ContextHeader
        {...baseProps}
        workspaceName="X"
        branch="main"
        gitStatus={{ branch: "main", changedFiles: [], ahead: 0, behind: 0, hasUpstream: false }}
      />,
    );
    expect(screen.queryByText(/unstaged/)).not.toBeInTheDocument();
  });

  it("renders the project name", () => {
    render(
      <ContextHeader
        projectName="hyperion"
        onOpenProjectSwitcher={vi.fn()}
        workspaceName="X"
        branch="main"
        gitStatus={null}
      />,
    );
    expect(screen.getByText("hyperion")).toBeInTheDocument();
  });

  it("calls onOpenProjectSwitcher when the project chip is clicked", () => {
    const onOpenProjectSwitcher = vi.fn();
    render(
      <ContextHeader
        projectName="octopus-sh"
        onOpenProjectSwitcher={onOpenProjectSwitcher}
        workspaceName="X"
        branch="main"
        gitStatus={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
    expect(onOpenProjectSwitcher).toHaveBeenCalled();
  });
});

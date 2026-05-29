import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextHeader } from "./ContextHeader";
import { useIssuesStore } from "../stores/issuesStore";

// Stub ipc so getIssue + openFileInSystem resolve without hitting Tauri
vi.mock("../lib/ipc", () => ({
  ipc: {
    getIssue: vi.fn().mockResolvedValue(null),
    openFileInSystem: vi.fn().mockResolvedValue(undefined),
  },
}));

const baseProps = {
  projectName: "octopus-sh",
  onOpenProjectSwitcher: vi.fn(),
};

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null });
});

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

  describe("ticket chip", () => {
    const issue = {
      key: "PROJ-123",
      summary: "Fix login",
      statusName: "In Progress",
      statusCategory: "inProgress" as const,
      issueType: "Story",
      priority: "High",
      url: "https://example.atlassian.net/browse/PROJ-123",
      parentKey: null,
    };

    it("renders the chip when key + issue present and tracker configured", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch="feat/PROJ-123-login"
          gitStatus={null}
          activeIssueKey="PROJ-123"
          issueTrackerConfigured
        />,
      );
      expect(screen.getByText("PROJ-123")).toBeInTheDocument();
      expect(screen.getByText(/In Progress/i)).toBeInTheDocument();
    });

    it("does not render the chip when no issue key is detected", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch="main"
          gitStatus={null}
          activeIssueKey={null}
          issueTrackerConfigured
        />,
      );
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("does not render the chip when tracker is not configured", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch="feat/PROJ-123-login"
          gitStatus={null}
          activeIssueKey="PROJ-123"
          issueTrackerConfigured={false}
        />,
      );
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("does not render the chip when issue is not found in the store (and no fallback yet)", () => {
      // Store is empty (null issues), getIssue mock returns null
      useIssuesStore.setState({ issues: null, loading: false, error: null });
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch="feat/PROJ-123-login"
          gitStatus={null}
          activeIssueKey="PROJ-123"
          issueTrackerConfigured
        />,
      );
      // No issue resolved synchronously → chip hidden
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });
  });
});

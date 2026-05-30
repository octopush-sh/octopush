import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextHeader } from "./ContextHeader";
import { useIssuesStore } from "../stores/issuesStore";
import type { Workspace } from "../lib/types";

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

    function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
      return {
        id: "w1",
        projectId: "p1",
        name: "ws",
        task: "",
        branch: "feat/PROJ-123-login",
        worktreePath: null,
        setupScript: "",
        status: "active",
        createdAt: "",
        lastActive: "",
        glyph: null,
        tint: null,
        testCommand: null,
        linkedIssueKey: null,
        issueLinkDismissed: false,
        ...overrides,
      };
    }

    function renderHeader(props: { workspace: Workspace; issueTrackerConfigured: boolean }) {
      return render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch={props.workspace.branch}
          gitStatus={null}
          workspace={props.workspace}
          issueTrackerConfigured={props.issueTrackerConfigured}
        />,
      );
    }

    it("renders the chip when key + issue present and tracker configured", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-123-login" }),
        issueTrackerConfigured: true,
      });
      expect(screen.getByText("PROJ-123")).toBeInTheDocument();
      expect(screen.getByText(/In Progress/i)).toBeInTheDocument();
    });

    it("does not render the chip when no issue key is detected", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      renderHeader({
        workspace: makeWorkspace({ branch: "main" }),
        issueTrackerConfigured: true,
      });
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("does not render the chip when tracker is not configured", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-123-login" }),
        issueTrackerConfigured: false,
      });
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("does not render the chip when issue is not found in the store (and no fallback yet)", () => {
      // Store is empty (null issues), getIssue mock returns null
      useIssuesStore.setState({ issues: null, loading: false, error: null });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-123-login" }),
        issueTrackerConfigured: true,
      });
      // No issue resolved synchronously → chip hidden
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("uses linkedIssueKey override when both manual link and branch key are present", async () => {
      const workspace = makeWorkspace({
        branch: "feat/IGNORED-9-foo",
        linkedIssueKey: "FORCED-1",
        issueLinkDismissed: false,
      });
      useIssuesStore.setState({
        issues: [
          { key: "FORCED-1", summary: "force", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: null, url: "https://x/FORCED-1", parentKey: null },
        ],
        loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
      });
      renderHeader({ workspace, issueTrackerConfigured: true });
      expect(await screen.findByText("FORCED-1")).toBeInTheDocument();
    });

    it("hides the chip when the linkage is dismissed", () => {
      const workspace = makeWorkspace({
        branch: "main",
        linkedIssueKey: null,
        issueLinkDismissed: true,
      });
      renderHeader({ workspace, issueTrackerConfigured: true });
      expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
    });

    it("hides the chip when the linkage is unlinked (no manual, no branch key, not dismissed)", () => {
      const workspace = makeWorkspace({
        branch: "main",
        linkedIssueKey: null,
        issueLinkDismissed: false,
      });
      renderHeader({ workspace, issueTrackerConfigured: true });
      expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
    });
  });
});

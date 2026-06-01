import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextHeader } from "./ContextHeader";
import { useIssuesStore } from "../stores/issuesStore";
import { ipc } from "../lib/ipc";
import type { Workspace } from "../lib/types";

// Stub ipc so getIssue + openFileInSystem resolve without hitting Tauri
vi.mock("../lib/ipc", () => ({
  ipc: {
    getIssue: vi.fn().mockResolvedValue(null),
    openFileInSystem: vi.fn().mockResolvedValue(undefined),
  },
}));

const baseProps = {};

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null });
});

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
      workspaceName={props.workspace.name}
      branch={props.workspace.branch}
      gitStatus={null}
      workspace={props.workspace}
      issueTrackerConfigured={props.issueTrackerConfigured}
    />,
  );
}

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

  it("with activeIssue, renders the ticket layout (KEY, status, summary, ◈) and no WORKSPACE block", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-name", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: "High",
          url: "https://x/browse/CLPNSNS-92", parentKey: null,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(await screen.findByText("CLPNSNS-92")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Consumir notificaciones")).toBeInTheDocument();
    expect(screen.queryByText(/^Workspace$/i)).not.toBeInTheDocument();
    expect(screen.queryByText("ws-name")).not.toBeInTheDocument();
  });

  it("with linkage=linked but activeIssue null (still loading), renders the degraded WORKSPACE block", () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-degraded", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: null, loading: true, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-degraded")).toBeInTheDocument();
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
  });

  it("with linkage=unlinked, renders the degraded WORKSPACE block", () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-main", task: "",
      branch: "main",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [], loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-main")).toBeInTheDocument();
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
  });

  it("clicking the ticket area calls ipc.openFileInSystem with the issue url", async () => {
    const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);
    openFileInSystemMock.mockResolvedValue(undefined);
    const workspace = {
      id: "w1", projectId: "p1", name: "ws", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "https://acme.atlassian.net/browse/CLPNSNS-92", parentKey: null,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    fireEvent.click(await screen.findByRole("button", { name: /open ticket/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith("https://acme.atlassian.net/browse/CLPNSNS-92");
  });

  it("status text uses the correct token per statusCategory", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null, issueLinkDismissed: false,
    };
    const cases: Array<["todo" | "inProgress" | "done" | "unknown", string]> = [
      ["inProgress", "text-octo-brass"],
      ["todo", "text-octo-mute"],
      ["done", "text-octo-verdigris"],
      ["unknown", "text-octo-sage"],
    ];
    for (const [category, expectedClass] of cases) {
      useIssuesStore.setState({
        issues: [
          {
            key: "CLPNSNS-92", summary: "x",
            statusName: category === "inProgress" ? "In Progress" : category === "done" ? "Done" : category === "todo" ? "To Do" : "Unknown",
            statusCategory: category,
            issueType: "Story", priority: null,
            url: "https://x/CLPNSNS-92", parentKey: null,
          },
        ],
        loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
      });
      const { unmount } = renderHeader({ workspace, issueTrackerConfigured: true });
      const statusEl = await screen.findByText(
        category === "inProgress" ? "In Progress" : category === "done" ? "Done" : category === "todo" ? "To Do" : "Unknown",
      );
      expect(statusEl).toHaveClass(expectedClass);
      unmount();
    }
  });
});

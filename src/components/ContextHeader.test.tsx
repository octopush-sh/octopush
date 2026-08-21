import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextHeader } from "./ContextHeader";
import { useIssuesStore } from "../stores/issuesStore";
import { useParentIssuesStore } from "../stores/parentIssuesStore";
import { ipc } from "../lib/ipc";
import type { Pr, Workspace } from "../lib/types";

// Stub ipc so getIssue + openFileInSystem resolve without hitting Tauri
vi.mock("../lib/ipc", () => ({
  ipc: {
    getIssue: vi.fn().mockResolvedValue(null),
    openFileInSystem: vi.fn().mockResolvedValue(undefined),
  },
}));

const copyMock = vi.fn().mockResolvedValue(true);
vi.mock("../lib/clipboard", () => ({ copyToClipboard: (...args: unknown[]) => copyMock(...args) }));

const baseProps = {};

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null });
  useParentIssuesStore.setState({ parents: {}, loading: {} });
  copyMock.mockClear();
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
    fromBranch: null,
    ...overrides,
  };
}

function renderHeader(props: {
  workspace: Workspace;
  issueTrackerConfigured?: boolean;
  jiraProjectKey?: string | null;
  pr?: Pr | null;
  onOpenPr?: (url: string) => void;
  openPr?: Pr | null; // legacy alias → forwarded as pr
}) {
  const prProp = props.pr ?? props.openPr ?? null;
  return render(
    <ContextHeader
      {...baseProps}
      workspaceName={props.workspace.name}
      branch={props.workspace.branch}
      gitStatus={null}
      workspace={props.workspace}
      issueTrackerConfigured={props.issueTrackerConfigured ?? false}
      jiraProjectKey={props.jiraProjectKey ?? null}
      pr={prProp}
      onOpenPr={props.onOpenPr}
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

  it("shows a Shield glyph when the mission's execution is sandboxed", () => {
    render(
      <ContextHeader
        {...baseProps}
        workspaceName="X"
        branch="feat/x"
        gitStatus={null}
        missionIntent="build"
        missionExecIsolation="sandbox"
      />,
    );
    expect(screen.getByTitle(/sandboxed execution/i)).toBeInTheDocument();
  });

  it("omits the sandbox glyph when execution is not sandboxed", () => {
    render(
      <ContextHeader
        {...baseProps}
        workspaceName="X"
        branch="feat/x"
        gitStatus={null}
        missionIntent="build"
        missionExecIsolation="none"
      />,
    );
    expect(screen.queryByTitle(/sandboxed execution/i)).not.toBeInTheDocument();
  });

  it("renders the branch on the chip and again in its provenance popover", () => {
    render(
      <ContextHeader {...baseProps} workspaceName="X" branch="feat/auth" gitStatus={null} />,
    );
    // The chip carries the (possibly elided) name; the popover carries the
    // full string, selectable. Short names appear whole in both.
    expect(screen.getByRole("button", { name: "Branch feat/auth" })).toHaveAttribute(
      "title",
      "feat/auth",
    );
    expect(screen.getAllByText("feat/auth")).toHaveLength(2);
  });

  describe("long branch names", () => {
    const LONG =
      "intermittent-component-not-found-detail-lookup-returns-a-hard-404-on-a-false-negative-empty-result-per-shard-copy-cached-empty-stale-replica-no-shard-failure-guard";

    it("middle-truncates the chip so the head AND the tail both survive", () => {
      render(<ContextHeader {...baseProps} workspaceName="X" branch={LONG} gitStatus={null} />);
      const chip = screen.getByRole("button", { name: `Branch ${LONG}` });
      // Head ellipsizes into whatever room is left; the last 12 chars are pinned.
      expect(chip.querySelector(".octo-midtrunc-head")).toHaveTextContent(LONG.slice(0, -12));
      expect(chip.querySelector(".octo-midtrunc-tail")).toHaveTextContent(LONG.slice(-12));
      // Nothing is lost: the whole string is one hover away, and in the title.
      expect(chip).toHaveAttribute("title", LONG);
    });

    it("never lets the branch displace the name line", () => {
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="a-workspace"
          branch={LONG}
          gitStatus={null}
        />,
      );
      // The name owns its own row, so it is present and titled whatever the
      // branch does beside it.
      expect(screen.getByText("a-workspace")).toHaveAttribute("title", "a-workspace");
    });
  });

  describe("branch provenance popover", () => {
    it("holds exactly what the ladder sheds — the branch and the base", () => {
      renderHeader({ workspace: makeWorkspace({ branch: "feat-x", fromBranch: "develop" }) });
      const pop = document.querySelector(".octo-prov-pop");
      expect(pop).toBeTruthy();
      expect(pop).toHaveTextContent("Branch");
      expect(pop).toHaveTextContent("Base");
      expect(pop).toHaveTextContent("develop");
    });

    it("does not repeat the changed-file count the tail already states", () => {
      render(
        <ContextHeader
          {...baseProps}
          workspaceName="X"
          branch="main"
          gitStatus={{
            branch: "main",
            changedFiles: [
              { path: "a.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
            ],
            ahead: 0,
            behind: 0,
            hasUpstream: false,
            conflicted: 0,
            aheadBehindKnown: true,
            operation: null,
          }}
        />,
      );
      // One number, stated once. The popover carries only what the header
      // folds away, never a second copy of what it still shows.
      expect(screen.getAllByText(/1 unstaged/)).toHaveLength(1);
      expect(document.querySelector(".octo-prov-pop")).not.toHaveTextContent(/unstaged|changed/);
    });

    it("copies the branch name without opening anything", async () => {
      render(
        <ContextHeader {...baseProps} workspaceName="X" branch="feat/auth" gitStatus={null} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /copy branch name/i }));
      expect(copyMock).toHaveBeenCalledWith("feat/auth", "Branch name copied");
      expect(vi.mocked(ipc.openFileInSystem)).not.toHaveBeenCalled();
    });
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
            { path: "a.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
            { path: "b.ts", status: "new", staged: false, unstaged: true, conflicted: false },
          ],
          ahead: 0,
          behind: 0, hasUpstream: false,
          conflicted: 0, aheadBehindKnown: true, operation: null,
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
        gitStatus={{ branch: "main", changedFiles: [], ahead: 0, behind: 0, hasUpstream: false, conflicted: 0, aheadBehindKnown: true, operation: null }}
      />,
    );
    expect(screen.queryByText(/unstaged/)).not.toBeInTheDocument();
  });


  describe("base branch provenance", () => {
    it("appends a mute 'from {base}' segment next to the branch when present", () => {
      renderHeader({
        workspace: makeWorkspace({ branch: "feat-x", fromBranch: "develop" }),
      });
      const seg = screen.getByText(/from develop/);
      expect(seg).toBeInTheDocument();
      expect(seg).toHaveAttribute(
        "title",
        "Base branch this workspace was created from",
      );
    });

    it("omits the segment when fromBranch is null", () => {
      renderHeader({ workspace: makeWorkspace({ branch: "feat-x", fromBranch: null }) });
      expect(screen.queryByText(/from /)).toBeNull();
    });

    it("omits the segment when fromBranch equals the branch itself", () => {
      renderHeader({ workspace: makeWorkspace({ branch: "main", fromBranch: "main" }) });
      expect(screen.queryByText(/from main/)).toBeNull();
    });
  });

  describe("the demotion ladder", () => {
    const issue = {
      key: "PROJ-7",
      summary: "Fix login",
      statusName: "In Progress",
      statusCategory: "inProgress" as const,
      issueType: "Story",
      priority: null,
      url: "u",
      parentKey: "EPIC-1",
      subtask: false,
      hierarchyLevel: 0,
    };

    it("makes the header its own query container, so the ladder reads the canvas width", () => {
      const { container } = render(
        <ContextHeader {...baseProps} workspaceName="X" branch="main" gitStatus={null} />,
      );
      expect(container.querySelector(".octo-header")).toBeTruthy();
    });

    it("carries the status as BOTH a dot and a name, so the rung can swap them", async () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      useParentIssuesStore.setState({
        parents: {
          "EPIC-1": {
            key: "EPIC-1", summary: "Epic", statusName: "In Progress",
            statusCategory: "inProgress", issueType: "Epic", priority: null,
            url: "u", parentKey: null, subtask: false, hierarchyLevel: 1,
          },
        },
        loading: {},
      });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-7" }),
        issueTrackerConfigured: true,
        jiraProjectKey: "PROJ",
      });

      const status = (await screen.findByText("In Progress")).closest(".octo-status");
      expect(status).toBeTruthy();
      // Only one is ever visible at a time — CSS swaps their widths at ≤640px.
      expect(status?.querySelector(".octo-status-dot")).toBeTruthy();
      expect(status?.querySelector(".octo-status-text")).toHaveTextContent("In Progress");
      expect(status).toHaveAttribute("title", "In Progress");
    });

    it("wraps the parent chain and the base branch in their demotion rungs", async () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      useParentIssuesStore.setState({
        parents: {
          "EPIC-1": {
            key: "EPIC-1", summary: "Epic", statusName: "In Progress",
            statusCategory: "inProgress", issueType: "Epic", priority: null,
            url: "u", parentKey: null, subtask: false, hierarchyLevel: 1,
          },
        },
        loading: {},
      });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-7", fromBranch: "develop" }),
        issueTrackerConfigured: true,
        jiraProjectKey: "PROJ",
      });

      expect((await screen.findByText("EPIC-1")).closest(".octo-demote-chain")).toBeTruthy();
      expect(screen.getByText(/from develop/)).toHaveClass("octo-demote-base");
      // The active key never demotes — it is the floor.
      expect(screen.getByText("PROJ-7").closest(".octo-demote")).toBeNull();
    });
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
      subtask: false,
      hierarchyLevel: 0,
    };

    it("renders the chip when key + issue present and tracker configured", () => {
      useIssuesStore.setState({ issues: [issue], loading: false, error: null });
      renderHeader({
        workspace: makeWorkspace({ branch: "feat/PROJ-123-login" }),
        issueTrackerConfigured: true,
        jiraProjectKey: "PROJ",
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
        jiraProjectKey: "PROJ",
      });
      // No issue resolved synchronously → chip hidden
      expect(screen.queryByText("PROJ-123")).not.toBeInTheDocument();
    });

    it("uses linkedIssueKey override when both manual link and branch key are present", async () => {
      const workspace = makeWorkspace({
        branch: "feat/IGNORED-9-foo",
        linkedIssueKey: "FORCED-1",
        fromBranch: null,
      });
      useIssuesStore.setState({
        issues: [
          { key: "FORCED-1", summary: "force", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: null, url: "https://x/FORCED-1", parentKey: null, subtask: false, hierarchyLevel: 0 },
        ],
        loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
      });
      renderHeader({ workspace, issueTrackerConfigured: true });
      expect(await screen.findByText("FORCED-1")).toBeInTheDocument();
    });

    it("hides the chip when the linkage is unlinked (no manual, no branch key)", () => {
      const workspace = makeWorkspace({
        branch: "main",
        linkedIssueKey: null,
        fromBranch: null,
      });
      renderHeader({ workspace, issueTrackerConfigured: true });
      // The ◈ diamond is retired app-wide — the type-tinted key marks the ticket.
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
    });
  });

  it("with activeIssue, renders the ticket grammar (KEY, status, summary) and no WORKSPACE label", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-name", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null,
      fromBranch: null,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: "High",
          url: "https://x/browse/CLPNSNS-92", parentKey: null,
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

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
      linkedIssueKey: null,
      fromBranch: null,
    };
    useIssuesStore.setState({
      issues: null, loading: true, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-degraded")).toBeInTheDocument();
    // The ◈ diamond is retired app-wide — the type-tinted key marks the ticket.
    expect(screen.queryByText(/◈/)).not.toBeInTheDocument();
  });

  it("with linkage=unlinked, renders the degraded WORKSPACE block", () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws-main", task: "",
      branch: "main",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null,
      fromBranch: null,
    };
    useIssuesStore.setState({
      issues: [], loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(screen.getByText(/^Workspace$/i)).toBeInTheDocument();
    expect(screen.getByText("ws-main")).toBeInTheDocument();
    // The ◈ diamond is retired app-wide — the type-tinted key marks the ticket.
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
      linkedIssueKey: null,
      fromBranch: null,
    };
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Consumir notificaciones",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "https://acme.atlassian.net/browse/CLPNSNS-92", parentKey: null,
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

    fireEvent.click(await screen.findByRole("button", { name: /open clpnsns-92/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith("https://acme.atlassian.net/browse/CLPNSNS-92");
  });

  it("per-key chip: clicking each ancestor opens THAT issue's url (not the active one)", async () => {
    const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);
    openFileInSystemMock.mockResolvedValue(undefined);
    const workspace = makeWorkspace({ branch: "feat/CLPNSNS-92" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Story",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "https://acme.atlassian.net/browse/CLPNSNS-92",
          parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic summary",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Epic", priority: null,
          url: "https://acme.atlassian.net/browse/EPIC-50",
          parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });
    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

    fireEvent.click(await screen.findByRole("button", { name: /open epic-50/i }));
    expect(openFileInSystemMock).toHaveBeenLastCalledWith("https://acme.atlassian.net/browse/EPIC-50");

    fireEvent.click(screen.getByRole("button", { name: /open clpnsns-92/i }));
    expect(openFileInSystemMock).toHaveBeenLastCalledWith("https://acme.atlassian.net/browse/CLPNSNS-92");
  });

  it("Story with Epic parent: chip shows EPIC-KEY (purple) · STORY-KEY (verdigris)", async () => {
    const workspace = makeWorkspace({ branch: "feat/CLPNSNS-92" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Story summary",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic summary",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });

    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

    const epicKey = await screen.findByText("EPIC-50");
    expect(epicKey).toHaveClass("text-state-purple");
    const storyKey = screen.getByText("CLPNSNS-92");
    expect(storyKey).toHaveClass("text-octo-verdigris");
  });

  it("Sub-task with Story + Epic chain: chip shows all 3 keys colored per type", async () => {
    const workspace = makeWorkspace({ branch: "main" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92.1", summary: "Sub-task",
          statusName: "To Do", statusCategory: "todo",
          issueType: "Sub-task", priority: null,
          url: "u", parentKey: "CLPNSNS-92",
          subtask: true, hierarchyLevel: -1,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "CLPNSNS-92": {
          key: "CLPNSNS-92", summary: "Story",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null, url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });
    const workspaceWithLink = { ...workspace, linkedIssueKey: "CLPNSNS-92.1" };
    renderHeader({ workspace: workspaceWithLink, issueTrackerConfigured: true });

    expect(await screen.findByText("EPIC-50")).toHaveClass("text-state-purple");
    expect(screen.getByText("CLPNSNS-92")).toHaveClass("text-octo-verdigris");
    expect(screen.getByText("CLPNSNS-92.1")).toHaveClass("text-state-blue");
  });

  it("Bug with Epic parent: ticket key uses rouge", async () => {
    const workspace = makeWorkspace({ branch: "feat/CLPNSNS-101" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-101", summary: "Notif duplicada",
          statusName: "Done", statusCategory: "done",
          issueType: "Bug", priority: null,
          url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic",
          statusName: "x", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });

    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });

    expect(await screen.findByText("CLPNSNS-101")).toHaveClass("text-octo-rouge");
    expect(screen.getByText("EPIC-50")).toHaveClass("text-state-purple");
  });

  it("Unmapped issueType falls back to brass on the ticket key", async () => {
    const workspace = makeWorkspace({ branch: "feat/SPIKE-1" });
    useIssuesStore.setState({
      issues: [
        {
          key: "SPIKE-1", summary: "Investigar perf",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Spike", priority: null,
          url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });

    renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "SPIKE" });

    expect(await screen.findByText("SPIKE-1")).toHaveClass("text-octo-brass");
  });

  it("PR chip in open state uses brass", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      pr: { number: 1, url: "u", title: "t", isDraft: false, state: "open" },
    });
    expect(screen.getByText("PR · #1")).toHaveClass("text-octo-brass");
  });

  it("PR chip in draft state uses mute", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      pr: { number: 2, url: "u", title: "t", isDraft: true, state: "draft" },
    });
    expect(screen.getByText("PR · #2")).toHaveClass("text-octo-mute");
  });

  it("PR chip in merged state uses state-purple", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      pr: { number: 3, url: "u", title: "t", isDraft: false, state: "merged" },
    });
    expect(screen.getByText("PR · #3")).toHaveClass("text-state-purple");
  });

  it("PR chip in closed state uses rouge", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      pr: { number: 4, url: "u", title: "t", isDraft: false, state: "closed" },
    });
    expect(screen.getByText("PR · #4")).toHaveClass("text-octo-rouge");
  });

  it("copy button copies the PR URL without opening it", async () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    const onOpenPr = vi.fn();
    renderHeader({
      workspace,
      pr: { number: 5, url: "https://github.com/acme/repo/pull/5", title: "t", isDraft: false, state: "open" },
      onOpenPr,
    });
    await userEvent.click(screen.getByRole("button", { name: /copy pr url/i }));
    expect(copyMock).toHaveBeenCalledWith("https://github.com/acme/repo/pull/5", "PR URL copied");
    expect(onOpenPr).not.toHaveBeenCalled();
  });

  it("clicking the PR chip text still opens the PR URL", async () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    const onOpenPr = vi.fn();
    renderHeader({
      workspace,
      pr: { number: 6, url: "https://github.com/acme/repo/pull/6", title: "t", isDraft: false, state: "open" },
      onOpenPr,
    });
    await userEvent.click(screen.getByText("PR · #6"));
    expect(onOpenPr).toHaveBeenCalledWith("https://github.com/acme/repo/pull/6");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("status text uses the correct token per statusCategory", async () => {
    const workspace = {
      id: "w1", projectId: "p1", name: "ws", task: "",
      branch: "feat/CLPNSNS-92",
      worktreePath: null, setupScript: "", status: "active",
      createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
      linkedIssueKey: null,
      fromBranch: null,
    };
    const cases: Array<["todo" | "inProgress" | "done" | "unknown", string]> = [
      ["inProgress", "text-state-blue"],   // changed from text-octo-brass
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
            subtask: false, hierarchyLevel: 0,
          },
        ],
        loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
      });
      const { unmount } = renderHeader({ workspace, issueTrackerConfigured: true, jiraProjectKey: "CLPNSNS" });
      const statusEl = await screen.findByText(
        category === "inProgress" ? "In Progress" : category === "done" ? "Done" : category === "todo" ? "To Do" : "Unknown",
      );
      expect(statusEl).toHaveClass(expectedClass);
      unmount();
    }
  });
});

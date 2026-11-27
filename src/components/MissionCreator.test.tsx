import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MissionCreator } from "./MissionCreator";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useCompanionPrefs } from "../stores/companionPrefsStore";
import { useChatStore } from "../stores/chatStore";
import * as ipcModule from "../lib/ipc";
import { TEST_ASK } from "../lib/testBrief";
import type { Workspace } from "../lib/types";

// Mock ipc
vi.mock("../lib/ipc", () => ({
  ipc: {
    updateWorkspaceLink: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    setProjectSetupScript: vi.fn().mockResolvedValue(undefined),
    conductorSetupScript: vi.fn().mockResolvedValue(null),
    shareWithMissions: vi.fn(),
    setShareWithMissions: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn(),
    listPrs: vi.fn(),
    ensurePrBranch: vi.fn(),
    getIssue: vi.fn(),
  },
}));

const { mockPushToast, mockMoveToGroup } = vi.hoisted(() => ({
  mockPushToast: vi.fn(),
  mockMoveToGroup: vi.fn().mockResolvedValue(true),
}));
vi.mock("./Toasts", () => ({ pushToast: mockPushToast }));
vi.mock("../lib/groupActions", () => ({ moveMissionToGroup: mockMoveToGroup }));

// Mock workspaceStore
vi.mock("../stores/workspaceStore", () => {
  const mockLoad = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const store = vi.fn(() => mockCreate) as unknown as typeof import("../stores/workspaceStore").useWorkspaceStore;
  (store as unknown as { getState: () => { load: typeof mockLoad } }).getState = () => ({ load: mockLoad });
  return { useWorkspaceStore: store };
});

const mockWorkspace: Workspace = {
  id: "ws-new-1",
  projectId: "proj-1",
  name: "add-dark-mode",
  task: "Add dark mode",
  branch: "add-dark-mode",
  worktreePath: null,
  setupScript: "",
  status: "active",
  createdAt: "2026-01-01",
  lastActive: "2026-01-01",
  glyph: null,
  tint: null,
  testCommand: null,
  linkedIssueKey: null,
  fromBranch: null,
};

const TASK_PLACEHOLDER = /e\.g\. Add dark mode/i;

// ─── Flow helpers (3 steps: Intent → Task & branch → Setup) ──────────

/** Step 1 (Intent) → Step 2 (Task & branch). Default intent is `build`. */
async function gotoTask() {
  fireEvent.click(screen.getByText("Continue"));
  return (await screen.findByPlaceholderText(TASK_PLACEHOLDER)) as HTMLInputElement;
}

/** From Step 2, advance to Step 3 (Setup) via the task input's Enter, then
 *  begin the mission. Enter avoids any transient two-"Continue" ambiguity. */
async function beginMission() {
  const taskInput = screen.getByPlaceholderText(TASK_PLACEHOLDER);
  fireEvent.keyDown(taskInput, { key: "Enter" });
  fireEvent.click(await screen.findByText("Begin the mission"));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useCompanionPrefs.setState({ setupScriptByProject: {} });
  vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue(null);
  vi.mocked(ipcModule.ipc.shareWithMissions).mockResolvedValue({
    saved: { link: [], copy: [] },
    available: { link: [], copy: [] },
  });
  vi.mocked(ipcModule.ipc.setShareWithMissions).mockResolvedValue(undefined);
  vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue(mockWorkspace));
  vi.mocked(ipcModule.ipc.listBranches).mockResolvedValue({
    local: ["main", "release/1.0"],
    remote: ["origin/dev"],
  });
});

describe("MissionCreator · Share with new missions", () => {
  function offer() {
    vi.mocked(ipcModule.ipc.shareWithMissions).mockResolvedValue({
      saved: { link: [], copy: [] },
      available: { link: ["node_modules"], copy: [".env"] },
    });
  }

  it("shows nothing when the main checkout has nothing to share", async () => {
    render(<MissionCreator projectId="proj-1" projectPath="/p" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
    await gotoTask();
    fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
    await screen.findByText("Begin the mission");
    expect(screen.queryByText("SHARE WITH NEW MISSIONS")).not.toBeInTheDocument();
  });

  it("offers what the checkout has, all off, and saves the choice before the worktree is made", async () => {
    offer();
    const order: string[] = [];
    vi.mocked(ipcModule.ipc.setShareWithMissions).mockImplementation(async () => {
      order.push("save");
    });
    const mockCreate = vi.fn().mockImplementation(async () => {
      order.push("create");
      return mockWorkspace;
    });
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
    render(<MissionCreator projectId="proj-1" projectPath="/p" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
    await gotoTask();
    fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
    const link = await screen.findByRole("switch", { name: "Link node_modules into new missions" });
    const copy = screen.getByRole("switch", { name: "Copy .env into new missions" });
    expect(link).toHaveAttribute("aria-checked", "false");
    expect(copy).toHaveAttribute("aria-checked", "false");
    const copyText = screen.getByText(/A linked folder is the main checkout's own folder, not a copy/);
    expect(copyText).toHaveTextContent(
      "an install or a clean run inside a mission changes it for the main checkout and for every other mission",
    );
    expect(copyText).toHaveTextContent("so agents in the mission can read it");
    expect(copyText).toHaveTextContent("Routines and workspaces created over MCP don't share.");
    expect(screen.getByText("copied into the worktree, readable by the mission's agents")).toBeInTheDocument();
    fireEvent.click(link);
    fireEvent.click(screen.getByText("Begin the mission"));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(ipcModule.ipc.setShareWithMissions).toHaveBeenCalledWith("proj-1", { link: ["node_modules"], copy: [] });
    expect(order).toEqual(["save", "create"]);
  });

  it("warns when a folder is linked and the setup script installs or cleans", async () => {
    offer();
    useCompanionPrefs.setState({ setupScriptByProject: { "proj-1": "npm ci\nnpm run build" } });
    render(<MissionCreator projectId="proj-1" projectPath="/p" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
    await gotoTask();
    fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
    const link = await screen.findByRole("switch", { name: "Link node_modules into new missions" });
    // Nothing is linked yet, so there is nothing to warn about.
    expect(screen.queryByText(/This setup script runs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Copy .env into new missions" }));
    expect(screen.queryByText(/This setup script runs/)).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(
      screen.getByText(
        "This setup script runs npm ci. With node_modules linked, that changes the main checkout's folder, for the main checkout and for every other mission.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.queryByText(/This setup script runs/)).not.toBeInTheDocument();
  });

  it("doesn't write an unchanged list", async () => {
    vi.mocked(ipcModule.ipc.shareWithMissions).mockResolvedValue({
      saved: { link: [], copy: [".env"] },
      available: { link: [], copy: [".env"] },
    });
    const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
    render(<MissionCreator projectId="proj-1" projectPath="/p" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
    await gotoTask();
    fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
    expect(await screen.findByRole("switch", { name: "Copy .env into new missions" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByText("Begin the mission"));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(ipcModule.ipc.setShareWithMissions).not.toHaveBeenCalled();
  });

  it("a failed save stops before the mission is created", async () => {
    offer();
    vi.mocked(ipcModule.ipc.setShareWithMissions).mockRejectedValue("db locked");
    const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
    render(<MissionCreator projectId="proj-1" projectPath="/p" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
    await gotoTask();
    fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
    fireEvent.click(await screen.findByRole("switch", { name: "Copy .env into new missions" }));
    fireEvent.click(screen.getByText("Begin the mission"));
    expect(await screen.findByText(/Couldn't save what this project shares with new missions: db locked/)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("MissionCreator", () => {
  it("pre-fills the task input when initialTask is provided", async () => {
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
    );
    const input = await gotoTask();
    expect(input.value).toBe("Add dark mode");
  });

  it("always shows a Close control that cancels the creator", async () => {
    const onCancel = vi.fn();
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={onCancel} initialTask="Add dark mode" />,
    );
    await gotoTask();
    fireEvent.click(await screen.findByLabelText("Close"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the creator and prevents the default (so the OS doesn't exit fullscreen)", () => {
    const onCancel = vi.fn();
    render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={onCancel} />);
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("calls ipc.updateWorkspaceLink with the new workspace id and key after create when linkIssueKeyOnCreate is set", async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
    const onCreated = vi.fn();
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" linkIssueKeyOnCreate="PROJ-99" />,
    );
    await gotoTask();
    await beginMission();
    await waitFor(() => {
      expect(vi.mocked(ipcModule.ipc.updateWorkspaceLink)).toHaveBeenCalledWith("ws-new-1", "PROJ-99");
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it("does NOT call ipc.updateWorkspaceLink when linkIssueKeyOnCreate is not set", async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
    const onCreated = vi.fn();
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
    );
    await gotoTask();
    await beginMission();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(vi.mocked(ipcModule.ipc.updateWorkspaceLink)).not.toHaveBeenCalled();
  });

  it("puts the new mission in the group it was started from", async () => {
    vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue(mockWorkspace));
    const onCreated = vi.fn();
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" groupId="group-7" />,
    );
    await gotoTask();
    await beginMission();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockMoveToGroup).toHaveBeenCalledWith("ws-new-1", "group-7");
  });

  it("leaves groups alone without a target group, and never steals an adopted workspace from its group", async () => {
    const onCreated = vi.fn();
    const { unmount } = render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
    );
    await gotoTask();
    await beginMission();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    unmount();

    // The branch already had a workspace, and it sits in another group.
    vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue({ ...mockWorkspace, groupId: "group-1" }));
    render(
      <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" groupId="group-7" />,
    );
    await gotoTask();
    await beginMission();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(mockMoveToGroup).not.toHaveBeenCalled();
  });

  // ─── Step 1: intent ────────────────────────────────────────────────

  describe("intent step", () => {
    it("defaults to `build` and passes it to create", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      // create(projectId, projectPath, name, task, branch, fromBranch, setupScript, intent, gitIsolation)
      expect(mockCreate.mock.calls[0][7]).toBe("build");
    });

    it("picking the Fix card records `fix` and advances to the task step", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Fix the bug" />,
      );
      fireEvent.click(screen.getByText("Fix something broken"));
      await screen.findByPlaceholderText(TASK_PLACEHOLDER); // advanced to step 2
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][7]).toBe("fix");
    });

    it("a Review mission is read-only — records `review` and forces `readonly` git isolation", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Audit the auth flow" />,
      );
      fireEvent.click(screen.getByText("Review the work"));
      await screen.findByPlaceholderText(TASK_PLACEHOLDER);
      // The Isolation disclosure shows the fixed read-only note, not the writer Listboxes.
      fireEvent.click(screen.getByRole("button", { name: "Isolation" }));
      expect(await screen.findByText(/Read-only\./)).toBeInTheDocument();
      expect(screen.queryByText("Own worktree")).not.toBeInTheDocument();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][7]).toBe("review");
      expect(mockCreate.mock.calls[0][8]).toBe("readonly");
    });

    it("a Probe mission also forces `readonly`", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Why is startup slow" />,
      );
      fireEvent.click(screen.getByText("Probe a question"));
      await screen.findByPlaceholderText(TASK_PLACEHOLDER);
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][7]).toBe("probe");
      expect(mockCreate.mock.calls[0][8]).toBe("readonly");
    });

    it("a Perf (Chase a regression) mission records `perf` + forces `readonly`", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Startup got 2x slower" />,
      );
      fireEvent.click(screen.getByText("Chase a regression"));
      await screen.findByPlaceholderText(TASK_PLACEHOLDER);
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][7]).toBe("perf");
      expect(mockCreate.mock.calls[0][8]).toBe("readonly");
    });
  });

  // ─── Test a ticket ─────────────────────────────────────────────────

  describe("test a ticket", () => {
    const TICKET = {
      key: "ENG-42",
      summary: "Keep the return path on sign-in",
      statusName: "In Review",
      statusCategory: "inProgress" as const,
      issueType: "Story",
      priority: null,
      url: "https://tracker.example.com/browse/ENG-42",
      parentKey: null,
      subtask: false,
      hierarchyLevel: 0,
      description: "Test plan: run sample-service, open /login?next=/billing.",
    };

    beforeEach(() => {
      useChatStore.setState({ composerSeedByWs: {} });
      vi.mocked(ipcModule.ipc.listPrs).mockResolvedValue([
        { number: 42, title: "Keep the return path", headRefName: "feat/ENG-42-return-path", author: "octocat" },
      ]);
      vi.mocked(ipcModule.ipc.ensurePrBranch).mockResolvedValue(undefined);
      vi.mocked(ipcModule.ipc.getIssue).mockResolvedValue(TICKET);
    });

    it("is card 6, with its tour id and key, and sends `test` + `ephemeral`", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Try the login fix" />);
      const card = screen.getByText("Test a ticket").closest("button")!;
      expect(card).toHaveAttribute("data-tour", "mission-intent-test");
      expect(card).toHaveTextContent("Build it, run it, ship nothing.");
      expect(card).toHaveTextContent("6");
      fireEvent.keyDown(window, { key: "6" });
      await screen.findByPlaceholderText(TASK_PLACEHOLDER);
      fireEvent.click(screen.getByRole("button", { name: "Isolation" }));
      expect(await screen.findByText(/Runs locally, ships nothing\./)).toBeInTheDocument();
      expect(screen.getByText(/A push, pull request or publish they ask for is refused by Octopush/)).toBeInTheDocument();
      expect(screen.queryByText("Own worktree")).not.toBeInTheDocument();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][7]).toBe("test");
      expect(mockCreate.mock.calls[0][8]).toBe("ephemeral");
      // No ticket linked: no brief.
      expect(ipcModule.ipc.getIssue).not.toHaveBeenCalled();
    });

    it("sends `ephemeral` with a PR picked too, from the PR's head", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Try the login fix" initialIntent="test" />);
      fireEvent.click(screen.getByText("Continue"));
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle("Start from a pull request"));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));
      await screen.findByText(/from PR #42/);
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("feat/ENG-42-return-path");
      expect(mockCreate.mock.calls[0][7]).toBe("test");
      expect(mockCreate.mock.calls[0][8]).toBe("ephemeral");
    });

    it("from a ticket: bases on the ticket's branch, makes test/<KEY>, and seeds the brief unsent", async () => {
      vi.mocked(ipcModule.ipc.listBranches).mockResolvedValue({
        local: ["main", "feat/ENG-4-other", "feat/ENG-42-return-path"],
        remote: ["origin/ENG-42-old"],
      });
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask={TICKET.summary} linkIssueKeyOnCreate="ENG-42" initialIntent="test" />,
      );
      expect(screen.getByText("Test a ticket").closest("button")).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByText("Continue"));
      await screen.findByTitle(/^Base branch: feat\/ENG-42-return-path/);
      expect((screen.getByLabelText("Branch name") as HTMLInputElement).value).toBe("test/ENG-42");
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][4]).toBe("test/ENG-42");
      expect(mockCreate.mock.calls[0][5]).toBe("feat/ENG-42-return-path");
      expect(mockCreate.mock.calls[0][8]).toBe("ephemeral");
      expect(ipcModule.ipc.getIssue).toHaveBeenCalledWith("ENG-42");
      await waitFor(() => expect(useChatStore.getState().composerSeedByWs["ws-new-1"]).toBeTruthy());
      const brief = useChatStore.getState().composerSeedByWs["ws-new-1"]!;
      expect(brief).toContain("Test ENG-42: Keep the return path on sign-in");
      expect(brief).toContain(TICKET.url);
      expect(brief).toContain(TICKET.description);
      expect(brief.endsWith(TEST_ASK)).toBe(true);
    });

    it("from a ticket with no branch of its own: bases on the repo default", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask={TICKET.summary} linkIssueKeyOnCreate="ENG-42" initialIntent="test" />,
      );
      fireEvent.click(screen.getByText("Continue"));
      expect(await screen.findByTitle(/^Base branch: main/)).toBeInTheDocument();
    });

    it("says the description couldn't be read when the ticket can't be", async () => {
      vi.mocked(ipcModule.ipc.getIssue).mockRejectedValue(new Error("jira issue HTTP 401"));
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask={TICKET.summary} linkIssueKeyOnCreate="ENG-42" initialIntent="test" />,
      );
      fireEvent.click(screen.getByText("Continue"));
      await screen.findByPlaceholderText(TASK_PLACEHOLDER);
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      await waitFor(() => expect(useChatStore.getState().composerSeedByWs["ws-new-1"]).toBeTruthy());
      const brief = useChatStore.getState().composerSeedByWs["ws-new-1"]!;
      expect(brief).toContain("Test ENG-42: Keep the return path on sign-in");
      expect(brief).toContain("The ticket's description couldn't be read.");
    });
  });

  // ─── Step 2: isolation ─────────────────────────────────────────────

  describe("git isolation", () => {
    it("defaults to `worktree` and passes it to create", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][8]).toBe("worktree");
    });

    it("the Isolation disclosure is collapsed by default", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const toggle = screen.getByRole("button", { name: "Isolation" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("base branch", () => {
    const TRIGGER_TITLE = "Base branch: main — the new branch starts from here";

    it("defaults to the first listed branch (the repo default) when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await waitFor(() => expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument());
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("main");
    });

    it("passes the picked branch as the base when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await waitFor(() => expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument());
      fireEvent.click(screen.getByTitle(TRIGGER_TITLE));
      fireEvent.click(screen.getByRole("menuitem", { name: /release\/1\.0/ }));
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("release/1.0");
    });

    it("offers remote branches and passes the full origin-qualified name as the base", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await waitFor(() => expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument());
      fireEvent.click(screen.getByTitle(TRIGGER_TITLE));
      expect(screen.getByText("REMOTE")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "origin/dev" }));
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("origin/dev");
    });

    it("still renders and creates with an empty base when listBranches fails", async () => {
      vi.mocked(ipcModule.ipc.listBranches).mockRejectedValue(new Error("not a repo"));
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      expect(screen.getByText("What are you setting out to do?")).toBeInTheDocument();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("");
    });
  });

  describe("editable branch name", () => {
    const BRANCH_TITLE = "Branch name — edit to set an exact name (e.g. feat/Foo)";

    it("renders the branch as an editable input that follows the task slug", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const input = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      expect(input.tagName).toBe("INPUT");
      expect(input.value).toBe("add-dark-mode");
      fireEvent.change(screen.getByPlaceholderText(TASK_PLACEHOLDER), { target: { value: "Fix checkout bug" } });
      expect(input.value).toBe("fix-checkout-bug");
    });

    it("an edited branch override survives later task edits", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "my-branch" } });
      fireEvent.change(screen.getByPlaceholderText(TASK_PLACEHOLDER), { target: { value: "Something else entirely" } });
      expect(branchInput.value).toBe("my-branch");
    });

    it("keeps an explicit override VERBATIM on blur (case + slashes preserved, only trimmed)", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "  feat/Foo-Bar  " } });
      fireEvent.blur(branchInput);
      expect(branchInput.value).toBe("feat/Foo-Bar");
    });

    it("clearing the override on blur falls back to the task slug", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "my-branch" } });
      fireEvent.change(branchInput, { target: { value: "" } });
      fireEvent.blur(branchInput);
      expect(branchInput.value).toBe("add-dark-mode");
    });

    it("passes the overridden branch (and name) when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      const branchInput = screen.getByTitle(BRANCH_TITLE);
      fireEvent.change(branchInput, { target: { value: "my-branch" } });
      fireEvent.blur(branchInput);
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][2]).toBe("my-branch");
      expect(mockCreate.mock.calls[0][4]).toBe("my-branch");
    });

    it("shows a quiet collision hint when the branch already exists, and clears it when it no longer collides", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      const branchInput = screen.getByTitle(BRANCH_TITLE);
      expect(screen.queryByText(/Branch exists/)).toBeNull();
      fireEvent.change(branchInput, { target: { value: "main" } });
      expect(screen.getByText("Branch exists — the workspace will reuse it")).toBeInTheDocument();
      fireEvent.change(branchInput, { target: { value: "fresh-branch" } });
      expect(screen.queryByText(/Branch exists/)).toBeNull();
    });

    it("a colliding branch does not block creation", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.change(screen.getByTitle(BRANCH_TITLE), { target: { value: "main" } });
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][4]).toBe("main");
    });
  });

  describe("start from a pull request", () => {
    const PR_BUTTON = "Start from a pull request";
    const CHIP_CLEAR = "Clear pull request base";
    const mockPrs = [
      { number: 42, title: "Add dark mode everywhere", headRefName: "feat/dark-mode", author: "octocat" },
      { number: 7, title: "Fix checkout bug", headRefName: "fix/checkout", author: null },
    ];

    beforeEach(() => {
      vi.mocked(ipcModule.ipc.listPrs).mockResolvedValue(mockPrs);
      vi.mocked(ipcModule.ipc.ensurePrBranch).mockResolvedValue(undefined);
    });

    it("opens a menu listing PRs with number, title, and author", async () => {
      render(
        <MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />,
      );
      await gotoTask();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      const row = await screen.findByRole("menuitem", { name: /#42/ });
      expect(row.textContent).toContain("Add dark mode everywhere");
      expect(row.textContent).toContain("octocat");
      expect(screen.getByRole("menuitem", { name: /#7/ })).toBeInTheDocument();
      expect(vi.mocked(ipcModule.ipc.listPrs)).toHaveBeenCalledWith("/home/user/proj");
    });

    it("picking a PR fetches its head, sets base, prefills empty task, shows the chip, and creates with `pr` isolation", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} />); // no initialTask
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));
      await waitFor(() => {
        expect(vi.mocked(ipcModule.ipc.ensurePrBranch)).toHaveBeenCalledWith("/home/user/proj", 42, "feat/dark-mode");
      });
      const taskInput = screen.getByPlaceholderText(TASK_PLACEHOLDER) as HTMLInputElement;
      expect(taskInput.value).toBe("Add dark mode everywhere");
      expect(screen.getByTitle(/^Base branch: feat\/dark-mode/)).toBeInTheDocument();
      expect(screen.getByText(/from PR #42/)).toBeInTheDocument();
      await beginMission();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("feat/dark-mode");
      // Picking a PR overrides isolation to `pr`.
      expect(mockCreate.mock.calls[0][8]).toBe("pr");
    });

    it("does not overwrite a task the user already typed", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Keep my words" />);
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));
      await waitFor(() => expect(screen.getByText(/from PR #42/)).toBeInTheDocument());
      const taskInput = screen.getByPlaceholderText(TASK_PLACEHOLDER) as HTMLInputElement;
      expect(taskInput.value).toBe("Keep my words");
    });

    it("clearing the chip restores the previous base", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));
      await screen.findByText(/from PR #42/);
      expect(screen.getByTitle(/^Base branch: feat\/dark-mode/)).toBeInTheDocument();
      fireEvent.click(screen.getByTitle(CHIP_CLEAR));
      expect(screen.queryByText(/from PR #42/)).toBeNull();
      expect(screen.getByTitle(/^Base branch: main/)).toBeInTheDocument();
    });

    it("shows a quiet empty state when the GitHub CLI is unavailable", async () => {
      vi.mocked(ipcModule.ipc.listPrs).mockRejectedValue(new Error("GitHub CLI not available"));
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoTask();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      expect(await screen.findByText("GitHub CLI not available")).toBeInTheDocument();
      expect(screen.queryByRole("menuitem")).toBeNull();
    });

    it("shows a quiet empty state when there are no open PRs", async () => {
      vi.mocked(ipcModule.ipc.listPrs).mockResolvedValue([]);
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoTask();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    });

    it("a failed head fetch surfaces a quiet error and leaves base and chip untouched", async () => {
      vi.mocked(ipcModule.ipc.ensurePrBranch).mockRejectedValue(new Error("network down"));
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));
      await screen.findByText(/Could not fetch the pull request branch/);
      expect(screen.queryByText(/from PR #42/)).toBeNull();
      expect(screen.getByTitle(/^Base branch: main/)).toBeInTheDocument();
    });
  });

  describe("per-project setup-script template", () => {
    it("prefills the setup step with the project's last-used setup script", async () => {
      useCompanionPrefs.setState({ setupScriptByProject: { "proj-1": "npm install && npm run prepare" } });
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" }); // → step 3
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      expect(textarea.value).toBe("npm install && npm run prepare");
    });

    it("leaves the setup step empty when the project has no remembered script", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
    });

    it("saves the script (even empty) back to the store on successful create", async () => {
      useCompanionPrefs.setState({ setupScriptByProject: { "proj-1": "old script" } });
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "" } });
      fireEvent.click(screen.getByText("Begin the mission"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(useCompanionPrefs.getState().setupScriptByProject["proj-1"]).toBe("");
    });

    it("also saves the template to the backend, where Routines read it", async () => {
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "pnpm install" } });
      fireEvent.click(screen.getByText("Begin the mission"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(ipcModule.ipc.setProjectSetupScript).toHaveBeenCalledWith("proj-1", "pnpm install");
      // A changed template is confirmed to the user.
      await waitFor(() =>
        expect(mockPushToast).toHaveBeenCalledWith(
          expect.objectContaining({ level: "info", title: "Setup script saved for this project" }),
        ),
      );
    });

    it("says the script becomes the project's template", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      expect(await screen.findByText(/Saved as this project's setup script/)).toBeInTheDocument();
    });

    it("stays quiet when the template didn't change", async () => {
      useCompanionPrefs.setState({ setupScriptByProject: { "proj-1": "npm ci" } });
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      fireEvent.click(await screen.findByText("Begin the mission"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      await waitFor(() => expect(ipcModule.ipc.setProjectSetupScript).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockPushToast).not.toHaveBeenCalled();
    });

    it("toasts when the template can't be saved", async () => {
      vi.mocked(ipcModule.ipc.setProjectSetupScript).mockRejectedValueOnce(new Error("database is locked"));
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "make setup" } });
      fireEvent.click(screen.getByText("Begin the mission"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockPushToast).toHaveBeenCalledWith(
          expect.objectContaining({ level: "error", title: "Couldn't save the project's setup script" }),
        ),
      );
    });

    it("says where the script runs, and that a reused workspace never re-runs it", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.keyDown(taskInput, { key: "Enter" });
      expect(await screen.findByText(/Runs in a setup terminal inside the new worktree/)).toBeInTheDocument();
      expect(screen.getByText(/These commands run in a setup terminal/)).toBeInTheDocument();

      fireEvent.click(screen.getByText("Back"));
      const branchInput = await screen.findByLabelText("Branch name");
      fireEvent.change(branchInput, { target: { value: "release/1.0" } });
      fireEvent.keyDown(screen.getByPlaceholderText(TASK_PLACEHOLDER), { key: "Enter" });
      expect(await screen.findByText(/never in a workspace it reuses/)).toBeInTheDocument();
      expect(screen.queryByText(/the setup script runs in its worktree/)).toBeNull();
    });

    it("does not save the script when creation fails", async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error("boom"));
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "make setup" } });
      fireEvent.click(screen.getByText("Begin the mission"));
      await screen.findByText(/boom/);
      expect(useCompanionPrefs.getState().setupScriptByProject["proj-1"]).toBeUndefined();
    });
  });

  describe("Conductor setup prefill", () => {
    const CONDUCTOR_LINE = "From .conductor/settings.toml · edit before it runs";

    async function gotoSetup() {
      const taskInput = await gotoTask();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      return (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
    }

    it("prefills from .conductor/settings.toml when the project has no template, and says so", async () => {
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue("cp \"$CONDUCTOR_ROOT_PATH/.env\" .env\nnpm install");
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      await waitFor(() => expect(textarea.value).toBe("cp \"$CONDUCTOR_ROOT_PATH/.env\" .env\nnpm install"));
      expect(ipcModule.ipc.conductorSetupScript).toHaveBeenCalledWith("proj-1");
      const line = screen.getByText(CONDUCTOR_LINE);
      expect(line).toHaveAttribute("data-tour", "mission-setup-conductor");
      expect(line.className).toContain("font-mono");
      expect(line.className).toContain("octo-rise-in");
      // Only a prefill: nothing was created or saved.
      expect(mockCreate).not.toHaveBeenCalled();
      expect(ipcModule.ipc.setProjectSetupScript).not.toHaveBeenCalled();
    });

    it("counts the lines of a script taller than the field", async () => {
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue(Array(9).fill("echo ok").join("\n"));
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoSetup();
      expect(await screen.findByText(`${CONDUCTOR_LINE} · 9 lines`)).toBeInTheDocument();
    });

    it("notes CONDUCTOR_PORT when the script reads it", async () => {
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue("npm run dev -- --port $CONDUCTOR_PORT");
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      await gotoSetup();
      expect(await screen.findByText(`${CONDUCTOR_LINE} · CONDUCTOR_PORT isn't set in Octopush`)).toBeInTheDocument();
    });

    it("never asks when the project has a remembered template", async () => {
      useCompanionPrefs.setState({ setupScriptByProject: { "proj-1": "npm ci" } });
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue("npm install");
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      expect(textarea.value).toBe("npm ci");
      expect(ipcModule.ipc.conductorSetupScript).not.toHaveBeenCalled();
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
    });

    it("stays empty and quiet without a Conductor script", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      await waitFor(() => expect(ipcModule.ipc.conductorSetupScript).toHaveBeenCalled());
      expect(textarea.value).toBe("");
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
    });

    it("stays empty when the lookup fails", async () => {
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockRejectedValue(new Error("no such command"));
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      await waitFor(() => expect(ipcModule.ipc.conductorSetupScript).toHaveBeenCalled());
      expect(textarea.value).toBe("");
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
    });

    it("never overwrites what the user already typed", async () => {
      let resolve: (v: string | null) => void = () => {};
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockReturnValue(new Promise((r) => (resolve = r)));
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      fireEvent.change(textarea, { target: { value: "make setup" } });
      // The late answer is flushed (effects and state) before the assertions.
      await act(async () => {
        resolve("npm install");
      });
      expect(textarea.value).toBe("make setup");
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
    });

    it("hides the line once the field no longer holds what was read, and saves the edited script as the template", async () => {
      vi.mocked(ipcModule.ipc.conductorSetupScript).mockResolvedValue("npm install");
      const onCreated = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={onCreated} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const textarea = await gotoSetup();
      await screen.findByText(CONDUCTOR_LINE);
      fireEvent.change(textarea, { target: { value: "npm install && make" } });
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
      fireEvent.change(textarea, { target: { value: "" } });
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
      // Back to exactly what the file says: the source is true again.
      fireEvent.change(textarea, { target: { value: "npm install" } });
      expect(screen.getByText(CONDUCTOR_LINE)).toBeInTheDocument();
      fireEvent.change(textarea, { target: { value: "pnpm i" } });
      expect(screen.queryByText(CONDUCTOR_LINE)).toBeNull();
      fireEvent.click(screen.getByText("Begin the mission"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(ipcModule.ipc.setProjectSetupScript).toHaveBeenCalledWith("proj-1", "pnpm i");
    });
  });

  describe("doctrine pass", () => {
    it("crossfades Intent → Task → Setup and lands on a single Begin CTA", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      expect(screen.getByText("What is this mission about?")).toBeInTheDocument();
      const taskInput = await gotoTask();
      expect(screen.getByText("What are you setting out to do?")).toBeInTheDocument();
      fireEvent.keyDown(taskInput, { key: "Enter" });
      expect(await screen.findByText("How does it start?")).toBeInTheDocument();
      expect(screen.getByText("Begin the mission")).toBeInTheDocument();
      // The setup copy mentions "skip" — only a Skip *button* is forbidden.
      expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    });

    it("Escape cancels the creator", () => {
      const onCancel = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={onCancel} initialTask="Add dark mode" />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("Escape with the branch menu open dismisses only the menu; a second Escape cancels", async () => {
      const onCancel = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={onCancel} initialTask="Add dark mode" />);
      await gotoTask();
      const trigger = await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "Choose base branch" })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape", cancelable: true, bubbles: true });
      expect(screen.queryByRole("menu", { name: "Choose base branch" })).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "Escape", cancelable: true, bubbles: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("an Escape already claimed by an inner layer (defaultPrevented) does NOT cancel", () => {
      const onCancel = vi.fn();
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={onCancel} initialTask="Add dark mode" />);
      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
      e.preventDefault();
      window.dispatchEvent(e);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("renders the continue hint as a <kbd>Enter</kbd> with no return glyph", () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const kbd = screen.getByText("Enter");
      expect(kbd.tagName).toBe("KBD");
      expect(document.body.textContent).not.toContain("↵");
    });

    it("Back buttons carry no arrow glyphs in their text", async () => {
      render(<MissionCreator projectId="proj-1" projectPath="/home/user/proj" onCreated={vi.fn()} onCancel={vi.fn()} initialTask="Add dark mode" />);
      const noArrows = (el: HTMLElement) => expect(el.textContent).not.toMatch(/[←→⟶↵«»‹›]/);
      // Step 1 has no Back (the persistent Close is the exit).
      screen.queryAllByRole("button", { name: /back/i }).forEach(noArrows);
      const taskInput = await gotoTask();
      screen.queryAllByRole("button", { name: /back/i }).forEach(noArrows); // step 2 Back
      fireEvent.keyDown(taskInput, { key: "Enter" });
      await screen.findByText("Begin the mission");
      screen.queryAllByRole("button", { name: /back/i }).forEach(noArrows); // step 3 Back
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MissionCreator } from "./MissionCreator";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useCompanionPrefs } from "../stores/companionPrefsStore";
import * as ipcModule from "../lib/ipc";
import type { Workspace } from "../lib/types";

// Mock ipc
vi.mock("../lib/ipc", () => ({
  ipc: {
    updateWorkspaceLink: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    listBranches: vi.fn(),
    listPrs: vi.fn(),
    ensurePrBranch: vi.fn(),
  },
}));

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
  vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue(mockWorkspace));
  vi.mocked(ipcModule.ipc.listBranches).mockResolvedValue({
    local: ["main", "release/1.0"],
    remote: ["origin/dev"],
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

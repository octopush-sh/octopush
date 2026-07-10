import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceCreator } from "./WorkspaceCreator";
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useCompanionPrefs.setState({ setupScriptByProject: {} });
  // Default: create resolves with the mock workspace
  vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue(mockWorkspace));
  vi.mocked(ipcModule.ipc.listBranches).mockResolvedValue({
    local: ["main", "release/1.0"],
    remote: ["origin/dev"],
  });
});

describe("WorkspaceCreator", () => {
  it("pre-fills the task input when initialTask is provided", () => {
    render(
      <WorkspaceCreator
        projectId="proj-1"
        projectPath="/home/user/proj"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
        initialTask="Add dark mode"
      />
    );
    const input = screen.getByPlaceholderText(/e\.g\. Add dark mode/i) as HTMLInputElement;
    expect(input.value).toBe("Add dark mode");
  });

  it("always shows a Close control that cancels the creator (both steps)", async () => {
    const onCancel = vi.fn();
    render(
      <WorkspaceCreator
        projectId="proj-1"
        projectPath="/home/user/proj"
        onCreated={vi.fn()}
        onCancel={onCancel}
        initialTask="Add dark mode"
      />
    );
    // Step 1: Close is present and exits.
    fireEvent.click(screen.getByText("Continue"));
    // Step 2: Close is still present (it's persistent, not step-scoped).
    const close = await screen.findByLabelText("Close");
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the creator and prevents the default (so the OS doesn't exit fullscreen)", () => {
    const onCancel = vi.fn();
    render(
      <WorkspaceCreator
        projectId="proj-1"
        projectPath="/home/user/proj"
        onCreated={vi.fn()}
        onCancel={onCancel}
      />
    );
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
      <WorkspaceCreator
        projectId="proj-1"
        projectPath="/home/user/proj"
        onCreated={onCreated}
        onCancel={vi.fn()}
        initialTask="Add dark mode"
        linkIssueKeyOnCreate="PROJ-99"
      />
    );

    // Navigate to step 2 and click Begin
    // Step 1 → 2 crossfades through the FadeSwap, so "Begin" mounts async.
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(await screen.findByText("Begin"));

    await waitFor(() => {
      expect(vi.mocked(ipcModule.ipc.updateWorkspaceLink)).toHaveBeenCalledWith(
        "ws-new-1",
        "PROJ-99"
      );
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it("does NOT call ipc.updateWorkspaceLink when linkIssueKeyOnCreate is not set", async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
    vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);

    const onCreated = vi.fn();
    render(
      <WorkspaceCreator
        projectId="proj-1"
        projectPath="/home/user/proj"
        onCreated={onCreated}
        onCancel={vi.fn()}
        initialTask="Add dark mode"
      />
    );

    // Step 1 → 2 crossfades through the FadeSwap, so "Begin" mounts async.
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(await screen.findByText("Begin"));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(vi.mocked(ipcModule.ipc.updateWorkspaceLink)).not.toHaveBeenCalled();
  });

  describe("base branch", () => {
    const TRIGGER_TITLE = "Base branch: main — the new branch starts from here";

    function renderCreator(onCreated = vi.fn()) {
      render(
        <WorkspaceCreator
          projectId="proj-1"
          projectPath="/home/user/proj"
          onCreated={onCreated}
          onCancel={vi.fn()}
          initialTask="Add dark mode"
        />
      );
      return onCreated;
    }

    it("defaults to the first listed branch (the repo default) when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      // Wait for branches to load into the picker trigger.
      await waitFor(() => {
        expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument();
      });

      // Step 1 → 2 crossfades through the FadeSwap, so "Begin" mounts async.
      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("main");
    });

    it("passes the picked branch as the base when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      await waitFor(() => {
        expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle(TRIGGER_TITLE));
      fireEvent.click(screen.getByRole("menuitem", { name: /release\/1\.0/ }));

      // Step 1 → 2 crossfades through the FadeSwap, so "Begin" mounts async.
      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("release/1.0");
    });

    it("offers remote branches and passes the full origin-qualified name as the base", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      await waitFor(() => {
        expect(screen.getByTitle(TRIGGER_TITLE)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle(TRIGGER_TITLE));
      expect(screen.getByText("REMOTE")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "origin/dev" }));

      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("origin/dev");
    });

    it("still renders and creates with an empty base when listBranches fails", async () => {
      vi.mocked(ipcModule.ipc.listBranches).mockRejectedValue(new Error("not a repo"));
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      // Creator renders fine — the picker degrades to a static label.
      expect(screen.getByText("What are you setting out to do?")).toBeInTheDocument();

      // Step 1 → 2 crossfades through the FadeSwap, so "Begin" mounts async.
      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      // Empty string lets the backend resolve the repo default.
      expect(mockCreate.mock.calls[0][5]).toBe("");
    });
  });

  describe("editable branch name", () => {
    const BRANCH_TITLE = "Branch name — edit to set an exact name (e.g. feat/Foo)";

    function renderCreator(onCreated = vi.fn()) {
      render(
        <WorkspaceCreator
          projectId="proj-1"
          projectPath="/home/user/proj"
          onCreated={onCreated}
          onCancel={vi.fn()}
          initialTask="Add dark mode"
        />
      );
      return onCreated;
    }

    it("renders the branch as an editable input that follows the task slug", () => {
      renderCreator();
      const input = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      expect(input.tagName).toBe("INPUT");
      expect(input.value).toBe("add-dark-mode");

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Add dark mode/i), {
        target: { value: "Fix checkout bug" },
      });
      expect(input.value).toBe("fix-checkout-bug");
    });

    it("an edited branch override survives later task edits", () => {
      renderCreator();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "my-branch" } });

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Add dark mode/i), {
        target: { value: "Something else entirely" },
      });
      expect(branchInput.value).toBe("my-branch");
    });

    it("keeps an explicit override VERBATIM on blur (case + slashes preserved, only trimmed)", () => {
      renderCreator();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      // Mixed case and a slash are valid git branch names — don't mangle them.
      fireEvent.change(branchInput, { target: { value: "  feat/Foo-Bar  " } });
      fireEvent.blur(branchInput);
      expect(branchInput.value).toBe("feat/Foo-Bar");
    });

    it("clearing the override on blur falls back to the task slug", () => {
      renderCreator();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "my-branch" } });
      fireEvent.change(branchInput, { target: { value: "" } });
      fireEvent.blur(branchInput);
      expect(branchInput.value).toBe("add-dark-mode");
    });

    it("passes the overridden branch (and name) when creating", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      const branchInput = screen.getByTitle(BRANCH_TITLE);
      fireEvent.change(branchInput, { target: { value: "my-branch" } });
      fireEvent.blur(branchInput);

      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      // create(projectId, projectPath, name, task, branch, fromBranch, setupScript)
      expect(mockCreate.mock.calls[0][2]).toBe("my-branch");
      expect(mockCreate.mock.calls[0][4]).toBe("my-branch");
    });

    it("shows a quiet collision hint when the branch already exists, and clears it when it no longer collides", async () => {
      renderCreator();
      // Wait for the mocked branches (["main", "release/1.0"]) to load.
      await screen.findByTitle(/^Base branch: main/);

      const branchInput = screen.getByTitle(BRANCH_TITLE);
      expect(screen.queryByText(/Branch exists/)).toBeNull();

      fireEvent.change(branchInput, { target: { value: "main" } });
      expect(
        screen.getByText("Branch exists — the workspace will reuse it"),
      ).toBeInTheDocument();

      fireEvent.change(branchInput, { target: { value: "fresh-branch" } });
      expect(screen.queryByText(/Branch exists/)).toBeNull();
    });

    it("a colliding branch does not block creation", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();
      await screen.findByTitle(/^Base branch: main/);

      fireEvent.change(screen.getByTitle(BRANCH_TITLE), { target: { value: "main" } });
      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));

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

    function renderCreator(props: { initialTask?: string } = {}) {
      const onCreated = vi.fn();
      render(
        <WorkspaceCreator
          projectId="proj-1"
          projectPath="/home/user/proj"
          onCreated={onCreated}
          onCancel={vi.fn()}
          {...props}
        />
      );
      return onCreated;
    }

    beforeEach(() => {
      vi.mocked(ipcModule.ipc.listPrs).mockResolvedValue(mockPrs);
      vi.mocked(ipcModule.ipc.ensurePrBranch).mockResolvedValue(undefined);
    });

    it("opens a menu listing PRs with number, title, and author", async () => {
      renderCreator();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      const row = await screen.findByRole("menuitem", { name: /#42/ });
      expect(row.textContent).toContain("Add dark mode everywhere");
      expect(row.textContent).toContain("octocat");
      expect(screen.getByRole("menuitem", { name: /#7/ })).toBeInTheDocument();
      expect(vi.mocked(ipcModule.ipc.listPrs)).toHaveBeenCalledWith("/home/user/proj");
    });

    it("picking a PR fetches its head, sets the base, prefills an empty task, and shows the chip", async () => {
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator(); // no initialTask — empty

      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));

      await waitFor(() => {
        expect(vi.mocked(ipcModule.ipc.ensurePrBranch)).toHaveBeenCalledWith(
          "/home/user/proj",
          42,
          "feat/dark-mode"
        );
      });
      // Task prefilled with the PR title.
      const taskInput = screen.getByPlaceholderText(/e\.g\. Add dark mode/i) as HTMLInputElement;
      expect(taskInput.value).toBe("Add dark mode everywhere");
      // Base now points at the PR head.
      expect(screen.getByTitle(/^Base branch: feat\/dark-mode/)).toBeInTheDocument();
      // The chip is visible.
      expect(screen.getByText(/from PR #42/)).toBeInTheDocument();

      // Create proceeds through the normal path with the PR head as base.
      fireEvent.click(screen.getByText("Continue"));
      fireEvent.click(await screen.findByText("Begin"));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][5]).toBe("feat/dark-mode");
    });

    it("does not overwrite a task the user already typed", async () => {
      renderCreator({ initialTask: "Keep my words" });
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));

      await waitFor(() => {
        expect(screen.getByText(/from PR #42/)).toBeInTheDocument();
      });
      const taskInput = screen.getByPlaceholderText(/e\.g\. Add dark mode/i) as HTMLInputElement;
      expect(taskInput.value).toBe("Keep my words");
    });

    it("clearing the chip restores the previous base", async () => {
      renderCreator();
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
      renderCreator();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      expect(await screen.findByText("GitHub CLI not available")).toBeInTheDocument();
      expect(screen.queryByRole("menuitem")).toBeNull();
    });

    it("shows a quiet empty state when there are no open PRs", async () => {
      vi.mocked(ipcModule.ipc.listPrs).mockResolvedValue([]);
      renderCreator();
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    });

    it("a failed head fetch surfaces a quiet error and leaves base and chip untouched", async () => {
      vi.mocked(ipcModule.ipc.ensurePrBranch).mockRejectedValue(new Error("network down"));
      renderCreator();
      await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(screen.getByTitle(PR_BUTTON));
      fireEvent.click(await screen.findByRole("menuitem", { name: /#42/ }));

      await screen.findByText(/Could not fetch the pull request branch/);
      expect(screen.queryByText(/from PR #42/)).toBeNull();
      expect(screen.getByTitle(/^Base branch: main/)).toBeInTheDocument();
    });
  });

  describe("per-project setup-script template", () => {
    function renderCreator(onCreated = vi.fn()) {
      render(
        <WorkspaceCreator
          projectId="proj-1"
          projectPath="/home/user/proj"
          onCreated={onCreated}
          onCancel={vi.fn()}
          initialTask="Add dark mode"
        />
      );
      return onCreated;
    }

    it("prefills step II with the project's last-used setup script", async () => {
      useCompanionPrefs.setState({
        setupScriptByProject: { "proj-1": "npm install && npm run prepare" },
      });
      renderCreator();
      fireEvent.click(screen.getByText("Continue"));
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      expect(textarea.value).toBe("npm install && npm run prepare");
    });

    it("leaves step II empty when the project has no remembered script", async () => {
      renderCreator();
      fireEvent.click(screen.getByText("Continue"));
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
    });

    it("saves the script (even empty) back to the store on successful create", async () => {
      useCompanionPrefs.setState({
        setupScriptByProject: { "proj-1": "old script" },
      });
      const mockCreate = vi.fn().mockResolvedValue(mockWorkspace);
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      const onCreated = renderCreator();

      fireEvent.click(screen.getByText("Continue"));
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "" } });
      fireEvent.click(screen.getByText("Begin"));

      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(useCompanionPrefs.getState().setupScriptByProject["proj-1"]).toBe("");
    });

    it("does not save the script when creation fails", async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error("boom"));
      vi.mocked(useWorkspaceStore).mockReturnValue(mockCreate);
      renderCreator();

      fireEvent.click(screen.getByText("Continue"));
      const textarea = (await screen.findByPlaceholderText("npm install")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "make setup" } });
      fireEvent.click(screen.getByText("Begin"));

      await screen.findByText(/boom/);
      expect(useCompanionPrefs.getState().setupScriptByProject["proj-1"]).toBeUndefined();
    });
  });

  describe("doctrine pass", () => {
    function renderCreator() {
      const onCancel = vi.fn();
      render(
        <WorkspaceCreator
          projectId="proj-1"
          projectPath="/home/user/proj"
          onCreated={vi.fn()}
          onCancel={onCancel}
          initialTask="Add dark mode"
        />
      );
      return onCancel;
    }

    it("reaches step 2 content through the FadeSwap crossfade", async () => {
      renderCreator();
      expect(screen.getByText("What are you setting out to do?")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Continue"));
      expect(await screen.findByText("How does it start?")).toBeInTheDocument();
      expect(screen.getByText("Begin")).toBeInTheDocument();
    });

    it("offers a single Begin CTA on the setup step — no Skip button", async () => {
      renderCreator();
      fireEvent.click(screen.getByText("Continue"));
      await screen.findByText("Begin");
      // (The setup copy mentions "skip" — only a Skip *button* is forbidden.)
      expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    });

    it("Escape cancels the creator", () => {
      const onCancel = renderCreator();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("Escape with the branch menu open dismisses only the menu; a second Escape cancels", async () => {
      const onCancel = renderCreator();

      // Wait for the mocked branches to load into the picker trigger.
      const trigger = await screen.findByTitle(/^Base branch: main/);
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "Choose base branch" })).toBeInTheDocument();

      // Real ordering, no pre-prevented event: the menu's capture-phase
      // listener must consume Escape before the creator's bubble listener.
      fireEvent.keyDown(window, { key: "Escape", cancelable: true, bubbles: true });
      expect(screen.queryByRole("menu", { name: "Choose base branch" })).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();

      // With the menu gone, Escape now reaches the creator and cancels it.
      fireEvent.keyDown(window, { key: "Escape", cancelable: true, bubbles: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("an Escape already claimed by an inner layer (defaultPrevented) does NOT cancel", () => {
      const onCancel = renderCreator();
      // Simulate a menu layer (e.g. the branch picker's useMenuChrome) that
      // consumed the Escape via preventDefault before it reaches the creator.
      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
      e.preventDefault();
      window.dispatchEvent(e);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("renders the continue hint as a <kbd>Enter</kbd> with no return glyph", () => {
      renderCreator();
      const kbd = screen.getByText("Enter");
      expect(kbd.tagName).toBe("KBD");
      expect(screen.getByText("to continue")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("↵");
    });

    it("Back buttons carry no arrow glyphs in their text", async () => {
      renderCreator();
      const noArrows = (el: HTMLElement) =>
        expect(el.textContent).not.toMatch(/[←→⟶↵«»‹›]/);
      // Step 1 has no Back button (the persistent Close is the exit); step 2's
      // Back is step navigation. queryAll tolerates the empty step-1 case.
      screen.queryAllByRole("button", { name: /back/i }).forEach(noArrows);

      fireEvent.click(screen.getByText("Continue"));
      await screen.findByText("Begin");
      screen.queryAllByRole("button", { name: /back/i }).forEach(noArrows);
    });
  });
});

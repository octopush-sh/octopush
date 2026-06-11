import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceCreator } from "./WorkspaceCreator";
import { useWorkspaceStore } from "../stores/workspaceStore";
import * as ipcModule from "../lib/ipc";
import type { Workspace } from "../lib/types";

// Mock ipc
vi.mock("../lib/ipc", () => ({
  ipc: {
    updateWorkspaceLink: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    listBranches: vi.fn(),
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
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: create resolves with the mock workspace
  vi.mocked(useWorkspaceStore).mockReturnValue(vi.fn().mockResolvedValue(mockWorkspace));
  vi.mocked(ipcModule.ipc.listBranches).mockResolvedValue(["main", "release/1.0"]);
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
    const BRANCH_TITLE = "Branch name — edit to override the suggested slug";

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

    it("slugify-validates the override on blur (lowercase, spaces to dashes)", () => {
      renderCreator();
      const branchInput = screen.getByTitle(BRANCH_TITLE) as HTMLInputElement;
      fireEvent.change(branchInput, { target: { value: "My Fancy Branch" } });
      fireEvent.blur(branchInput);
      expect(branchInput.value).toBe("my-fancy-branch");
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
      screen.getAllByRole("button", { name: /back/i }).forEach(noArrows);

      fireEvent.click(screen.getByText("Continue"));
      await screen.findByText("Begin");
      screen.getAllByRole("button", { name: /back/i }).forEach(noArrows);
    });
  });
});

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
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Begin"));

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

    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Begin"));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(vi.mocked(ipcModule.ipc.updateWorkspaceLink)).not.toHaveBeenCalled();
  });
});

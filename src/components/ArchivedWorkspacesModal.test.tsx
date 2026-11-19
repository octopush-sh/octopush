import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";

const mockIpc = vi.hoisted(() => ({ listArchivedWorkspaces: vi.fn(), restoreWorkspace: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

import { ArchivedWorkspacesModal } from "./ArchivedWorkspacesModal";
import { useGroupsStore } from "../stores/groupsStore";

const archived = (id: string, groupId: string | null): Workspace => ({
  id,
  projectId: "p1",
  name: id,
  task: "",
  branch: `branch-${id}`,
  worktreePath: null,
  setupScript: "",
  status: "archived",
  createdAt: "",
  lastActive: "",
  glyph: null,
  tint: null,
  linkedIssueKey: null,
  fromBranch: null,
  groupId,
});

const group: Group = {
  id: "g1",
  scope: "workspace",
  projectId: "p1",
  name: "PR reviews",
  tint: null,
  sortOrder: 0,
  createdAt: "2026-11-01T00:00:00Z",
};

beforeEach(() => {
  mockIpc.listArchivedWorkspaces.mockReset();
  useGroupsStore.setState({ groups: [group], loaded: true });
});

describe("ArchivedWorkspacesModal", () => {
  it("shows the group an archived mission will return to, and nothing for a loose or orphaned one", async () => {
    mockIpc.listArchivedWorkspaces.mockResolvedValue([
      archived("in-group", "g1"),
      archived("loose", null),
      archived("orphan", "gone"),
    ]);
    render(
      <ArchivedWorkspacesModal projectId="p1" projectName="Backend" projectPath="/repo" onRestored={vi.fn()} onClose={vi.fn()} />,
    );
    const row = (await screen.findByText("in-group")).closest("li")!;
    expect(row).toHaveTextContent("PR reviews ·");
    expect(row.querySelector('[title=\'In the group "PR reviews"\']')).not.toBeNull();
    expect(screen.getByText("loose").closest("li")).not.toHaveTextContent("·");
    expect(screen.getByText("orphan").closest("li")).not.toHaveTextContent("·");
  });
});

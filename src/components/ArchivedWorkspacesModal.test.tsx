import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";

const mockIpc = vi.hoisted(() => ({ listArchivedWorkspaces: vi.fn(), restoreWorkspace: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

import { ArchivedWorkspacesModal } from "./ArchivedWorkspacesModal";
import { useGroupsStore } from "../stores/groupsStore";
import { layoutMissions } from "../lib/railGroups";

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
    expect(row.querySelector('[title=\'In the group "PR reviews": restoring returns it there\']')).not.toBeNull();
    expect(screen.getByText("loose").closest("li")).not.toHaveTextContent("·");
    expect(screen.getByText("orphan").closest("li")).not.toHaveTextContent("·");
  });

  it("shows no group for a group of another project (it would not take the mission back)", async () => {
    useGroupsStore.setState({ groups: [{ ...group, id: "g-other", projectId: "p2", name: "Fixes" }], loaded: true });
    mockIpc.listArchivedWorkspaces.mockResolvedValue([archived("stray", "g-other")]);
    render(
      <ArchivedWorkspacesModal projectId="p1" projectName="acme-api" projectPath="/repo" onRestored={vi.fn()} onClose={vi.fn()} />,
    );
    expect((await screen.findByText("stray")).closest("li")).not.toHaveTextContent("Fixes");
  });

  it("restores a mission that keeps its group: it rejoins the group if it still exists, else it is loose", async () => {
    mockIpc.listArchivedWorkspaces.mockResolvedValue([archived("fix-json-parser", "g1")]);
    mockIpc.restoreWorkspace.mockResolvedValue(undefined);
    const onRestored = vi.fn();
    render(
      <ArchivedWorkspacesModal projectId="p1" projectName="acme-api" projectPath="/repo" onRestored={onRestored} onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith("p1"));
    expect(mockIpc.restoreWorkspace).toHaveBeenCalledWith("fix-json-parser", "/repo", "branch-fix-json-parser", null);
    // The backend keeps `group_id` on restore; the rail reads the row back.
    const restored = { ...archived("fix-json-parser", "g1"), status: "active" };
    const [inGroup] = layoutMissions([restored], [group]);
    expect(inGroup.kind === "group" && inGroup.members.map((w) => w.id)).toEqual(["fix-json-parser"]);
    // Removing the group cleared the id on the backend; a stale id the rail
    // still sees names no group, which is drawn loose all the same.
    expect(layoutMissions([{ ...restored, groupId: null }], [])[0].kind).toBe("mission");
    expect(layoutMissions([restored], [])[0].kind).toBe("mission");
  });
});

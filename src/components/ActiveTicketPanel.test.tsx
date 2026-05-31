import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActiveTicketPanel } from "./ActiveTicketPanel";
import type { Issue } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: {
    openFileInSystem: vi.fn(),
    updateWorkspaceLink: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn(),
  },
}));

// Mock the workspaceStore so the post-link reload in ActiveTicketPanel
// doesn't hit a real ipc.listWorkspaces during component tests.
const loadWorkspacesMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    vi.fn(() => ({ load: loadWorkspacesMock })),
    { getState: () => ({ load: loadWorkspacesMock }) },
  ),
}));

import { ipc } from "../lib/ipc";
const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);
const updateWorkspaceLinkMock = vi.mocked(ipc.updateWorkspaceLink);

const issue: Issue = {
  key: "CLPNSNS-92",
  summary: "Consumir el servicio de notificaciones del backend",
  statusName: "In Progress",
  statusCategory: "inProgress",
  issueType: "Story",
  priority: "High",
  url: "https://acme.atlassian.net/browse/CLPNSNS-92",
  parentKey: "EPIC-1",
};

beforeEach(() => { vi.clearAllMocks(); });

describe("ActiveTicketPanel", () => {
  it("linked state: shows key + status + summary + meta + open-in-Jira", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-92", source: "detected" }}
        activeIssue={issue}
        issuesLoaded={true}
        candidates={[issue]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    expect(screen.getByText("CLPNSNS-92")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText(/notificaciones/i)).toBeInTheDocument();
    expect(screen.getByText(/STORY · HIGH/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open in jira/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith(issue.url);
  });

  it("unlinked state: returns null (component is not rendered by Companion when unlinked)", () => {
    const { container } = render(
      <ActiveTicketPanel
        state={{ kind: "unlinked" }}
        activeIssue={null}
        issuesLoaded={true}
        candidates={[]}
        projectKey={null}
        workspaceId="w1"
        projectId="p1"
      />,
    );
    // Defensive early return — component renders nothing when not linked
    expect(container.firstChild).toBeNull();
  });

  it("dismissed state: returns null (component is not rendered by Companion when dismissed)", () => {
    const { container } = render(
      <ActiveTicketPanel
        state={{ kind: "dismissed" }}
        activeIssue={null}
        issuesLoaded={true}
        candidates={[]}
        projectKey={null}
        workspaceId="w1"
        projectId="p1"
      />,
    );
    // Defensive early return — component renders nothing when not linked
    expect(container.firstChild).toBeNull();
  });

  it("linked but activeIssue is null: shows error card with Unlink", async () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-X", source: "manual" }}
        activeIssue={null}
        issuesLoaded={true}
        candidates={[]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unlink/i }));
    await waitFor(() => {
      expect(updateWorkspaceLinkMock).toHaveBeenCalledWith("w1", null, false);
    });
  });

  it("reloads workspaceStore after updateWorkspaceLink (via Unlink on error card)", async () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-X", source: "manual" }}
        activeIssue={null}
        issuesLoaded={true}
        candidates={[]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /unlink/i }));
    await waitFor(() => {
      expect(updateWorkspaceLinkMock).toHaveBeenCalledWith("w1", null, false);
      expect(loadWorkspacesMock).toHaveBeenCalledWith("p1");
    });
  });

  it("healthy linked card exposes Change + Unlink affordances", async () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-92", source: "detected" }}
        activeIssue={issue}
        issuesLoaded={true}
        candidates={[issue]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    expect(screen.getByRole("button", { name: /change ticket/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlink/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unlink/i }));
    await waitFor(() => {
      expect(updateWorkspaceLinkMock).toHaveBeenCalledWith("w1", null, false);
      expect(loadWorkspacesMock).toHaveBeenCalledWith("p1");
    });
  });

  it("Change on a healthy linked card opens the inline picker", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-92", source: "detected" }}
        activeIssue={issue}
        issuesLoaded={true}
        candidates={[issue]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /change ticket/i }));
    expect(screen.getByPlaceholderText(/search by key or summary/i)).toBeInTheDocument();
    // The linked card body is hidden while the picker is open.
    expect(screen.queryByRole("button", { name: /open in jira/i })).not.toBeInTheDocument();
  });

  it("linked + null activeIssue + issuesLoaded=false: suppresses error card (first paint)", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-92", source: "detected" }}
        activeIssue={null}
        issuesLoaded={false}
        candidates={[]}
        projectKey="CLPNSNS"
        workspaceId="w1"
        projectId="p1"
      />,
    );
    // Eyebrow still renders, but the error card + Unlink button must not
    // appear while the global issues list is still loading on first paint.
    expect(screen.getByText(/active ticket/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unlink/i })).not.toBeInTheDocument();
  });
});

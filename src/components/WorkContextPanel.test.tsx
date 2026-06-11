import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import { WorkContextPanel } from "./WorkContextPanel";
import { useIssuesStore } from "../stores/issuesStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useCompanionPrefs } from "../stores/companionPrefsStore";
import type { Issue, Workspace } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listMyIssues: vi.fn(),
    getIssue: vi.fn(),
    openFileInSystem: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
const listMyIssuesMock = vi.mocked(ipc.listMyIssues);
const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);

const issue: Issue = {
  key: "AB-1",
  summary: "alpha ticket",
  statusName: "In Progress",
  statusCategory: "inProgress",
  issueType: "Story",
  priority: null,
  url: "https://x/AB-1",
  parentKey: null,
  subtask: false,
  hierarchyLevel: 0,
};

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  name: "alpha-ws",
  task: "",
  branch: "feat/AB-1",
  worktreePath: null,
  setupScript: "",
  status: "active",
  createdAt: "",
  lastActive: "",
  glyph: null,
  tint: null,
  testCommand: null,
  linkedIssueKey: null,
} as Workspace;

beforeEach(() => {
  vi.clearAllMocks();
  listMyIssuesMock.mockResolvedValue([issue]);
  openFileInSystemMock.mockResolvedValue(undefined);
  localStorage.clear();
  useIssuesStore.setState({
    issues: [issue],
    loading: false,
    error: null,
    detailByKey: {},
    detailLoadingByKey: {},
    epicIssuesByKey: {},
    epicLoadingByKey: {},
  });
  useWorkspaceStore.setState({ workspaces: [workspace] });
  useCompanionPrefs.setState({ workContextCollapsed: {} });
});

function renderPanel(extra: Partial<ComponentProps<typeof WorkContextPanel>> = {}) {
  return render(
    <WorkContextPanel
      configured
      projectKey="AB"
      projectId="p1"
      activeKey={null}
      {...extra}
    />,
  );
}

describe("WorkContextPanel ticket rows", () => {
  it("row is a plain container with exactly two sibling buttons (no nested interactive)", async () => {
    renderPanel();
    const row = await screen.findByTitle("AB-1 · alpha ticket");
    // The row itself is NOT a button (no role) — children-presentational fix.
    expect(row).not.toHaveAttribute("role");
    expect(row).not.toHaveAttribute("tabindex");
    // Main open-in-Jira button + workspace jump chip, as siblings.
    const buttons = within(row).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName("Open AB-1 · alpha ticket");
    expect(buttons[1]).toHaveAccessibleName("Jump to workspace alpha-ws");
    // No button nested inside another button.
    for (const b of buttons) {
      expect(b.closest("button")).toBe(b);
      expect(b.parentElement?.closest("button")).toBeNull();
    }
  });

  it("clicking the main button opens the ticket url", async () => {
    renderPanel();
    const row = await screen.findByTitle("AB-1 · alpha ticket");
    fireEvent.click(within(row).getByRole("button", { name: /open ab-1/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith("https://x/AB-1");
  });
});

describe("WorkContextPanel collapse", () => {
  it("follows defaultCollapsed when the user has not toggled", async () => {
    const { container } = renderPanel({ defaultCollapsed: true });
    await screen.findByTitle("AB-1 · alpha ticket");
    const body = container.querySelector("[inert]");
    expect(body).not.toBeNull();
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByRole("button", { name: "Expand work context" }),
    ).toBeInTheDocument();
  });

  it("expands by default in talk (defaultCollapsed=false) with no inert body", async () => {
    const { container } = renderPanel({ defaultCollapsed: false });
    await screen.findByTitle("AB-1 · alpha ticket");
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("persists a user toggle per project, overriding the default", async () => {
    renderPanel({ defaultCollapsed: false });
    await screen.findByTitle("AB-1 · alpha ticket");
    fireEvent.click(screen.getByRole("button", { name: "Collapse work context" }));
    expect(useCompanionPrefs.getState().workContextCollapsed["p1"]).toBe(true);
    // A stored value wins over the mode default on the next render.
    const second = renderPanel({ defaultCollapsed: false });
    expect(second.container.querySelector("[inert]")).not.toBeNull();
  });
});

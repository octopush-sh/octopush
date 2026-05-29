import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BacklogPanel } from "./BacklogPanel";
import { useIssuesStore } from "../stores/issuesStore";
import * as ipc from "../lib/ipc";

// Mock ipc so the store's load() call resolves without side-effects by default.
vi.mock("../lib/ipc", () => ({
  ipc: {
    listMyIssues: vi.fn().mockResolvedValue([]),
    openFileInSystem: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  // Reset to clean state and replace load with a no-op so mounting
  // doesn't trigger async state changes that stomp on per-test setup.
  useIssuesStore.setState({
    issues: null,
    loading: false,
    error: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
});

describe("BacklogPanel", () => {
  it("shows the BACKLOG eyebrow", () => {
    render(<BacklogPanel activeKey={null} configured />);
    expect(screen.getByText(/backlog/i)).toBeInTheDocument();
  });

  it("prompts to connect when not configured", () => {
    render(<BacklogPanel activeKey={null} configured={false} />);
    expect(screen.getByText(/connect jira/i)).toBeInTheDocument();
  });

  it("shows loading state while loading with no issues", () => {
    useIssuesStore.setState({ issues: null, loading: true, error: null });
    render(<BacklogPanel activeKey={null} configured />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows error state when load fails", () => {
    useIssuesStore.setState({ issues: null, loading: false, error: "Network error" });
    render(<BacklogPanel activeKey={null} configured />);
    expect(screen.getByText(/couldn.*t reach jira/i)).toBeInTheDocument();
  });

  it("shows empty state when no issues", () => {
    useIssuesStore.setState({ issues: [], loading: false, error: null });
    render(<BacklogPanel activeKey={null} configured />);
    expect(screen.getByText(/no assigned tickets/i)).toBeInTheDocument();
  });

  it("lists issues with key + summary + status", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "PROJ-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "https://example.atlassian.net/browse/PROJ-123",
          parentKey: null,
        },
      ],
    });
    render(<BacklogPanel activeKey="PROJ-123" configured />);
    expect(screen.getByText("PROJ-123")).toBeInTheDocument();
    expect(screen.getByText("Login")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  it("highlights the active row with brass treatment", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "PROJ-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "u",
          parentKey: null,
        },
        {
          key: "PROJ-456",
          summary: "Other",
          statusName: "To Do",
          statusCategory: "todo",
          issueType: "Task",
          priority: null,
          url: "u2",
          parentKey: null,
        },
      ],
    });
    render(<BacklogPanel activeKey="PROJ-123" configured />);
    // Active row should have brass-dim inline border + brass-ghost background
    const activeKeyEl = screen.getByText("PROJ-123");
    const rowBtn = activeKeyEl.closest("[role='button']") as HTMLElement;
    expect(rowBtn?.style.borderLeft).toContain("brass-dim");
    expect(rowBtn?.style.background).toContain("brass-ghost");
    // Inactive row should have a transparent border (no visual shift)
    const inactiveKeyEl = screen.getByText("PROJ-456");
    const inactiveBtn = inactiveKeyEl.closest("[role='button']") as HTMLElement;
    expect(inactiveBtn?.style.borderLeft).toContain("transparent");
  });

  it("clicking a ticket row calls openFileInSystem with its url", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "PROJ-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "https://example.atlassian.net/browse/PROJ-123",
          parentKey: null,
        },
      ],
    });
    render(<BacklogPanel activeKey={null} configured />);
    fireEvent.click(screen.getByText("PROJ-123").closest("[role='button']")!);
    expect(vi.mocked(ipc.ipc.openFileInSystem)).toHaveBeenCalledWith(
      "https://example.atlassian.net/browse/PROJ-123",
    );
  });

  it("clicking the refresh button calls load()", () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useIssuesStore.setState({
      issues: [],
      loading: false,
      error: null,
      load,
    });
    render(<BacklogPanel activeKey={null} configured />);
    fireEvent.click(screen.getByLabelText("Refresh backlog"));
    expect(load).toHaveBeenCalled();
  });
});

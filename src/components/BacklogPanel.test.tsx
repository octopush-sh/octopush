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
    render(<BacklogPanel activeKey={null} configured projectKey={null} />);
    expect(screen.getByText(/backlog/i)).toBeInTheDocument();
  });

  it("prompts to connect when not configured", () => {
    render(<BacklogPanel activeKey={null} configured={false} projectKey={null} />);
    expect(screen.getByText(/connect jira/i)).toBeInTheDocument();
  });

  it("shows loading state while loading with no issues", () => {
    useIssuesStore.setState({ issues: null, loading: true, error: null });
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows error state when load fails", () => {
    useIssuesStore.setState({ issues: null, loading: false, error: "Network error" });
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    expect(screen.getByText(/couldn't refresh/i)).toBeInTheDocument();
  });

  it("shows empty state when no issues in the project", () => {
    useIssuesStore.setState({ issues: [], loading: false, error: null });
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    expect(screen.getByText(/backlog clear/i)).toBeInTheDocument();
  });

  it("lists issues with key + summary + status", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "https://example.atlassian.net/browse/CLPNSNS-123",
          parentKey: null,
        },
      ],
    });
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    expect(screen.getByText("CLPNSNS-123")).toBeInTheDocument();
    expect(screen.getByText("Login")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  it("excludes the active key row from the backlog (active ticket lives in ActiveTicketPanel)", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "u",
          parentKey: null,
        },
        {
          key: "CLPNSNS-456",
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
    render(<BacklogPanel activeKey="CLPNSNS-123" configured projectKey="CLPNSNS" />);
    // Active key is excluded from the backlog list
    expect(screen.queryByText("CLPNSNS-123")).not.toBeInTheDocument();
    // Non-active key is still shown
    expect(screen.getByText("CLPNSNS-456")).toBeInTheDocument();
    const inactiveBtn = screen.getByText("CLPNSNS-456").closest("[role='button']") as HTMLElement;
    expect(inactiveBtn?.style.borderLeft).toContain("transparent");
  });

  it("clicking a ticket row calls openFileInSystem with its url", () => {
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-123",
          summary: "Login",
          statusName: "In Progress",
          statusCategory: "inProgress",
          issueType: "Story",
          priority: "High",
          url: "https://example.atlassian.net/browse/CLPNSNS-123",
          parentKey: null,
        },
      ],
    });
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    fireEvent.click(screen.getByText("CLPNSNS-123").closest("[role='button']")!);
    expect(vi.mocked(ipc.ipc.openFileInSystem)).toHaveBeenCalledWith(
      "https://example.atlassian.net/browse/CLPNSNS-123",
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
    render(<BacklogPanel activeKey={null} configured projectKey="CLPNSNS" />);
    fireEvent.click(screen.getByLabelText("Refresh backlog"));
    expect(load).toHaveBeenCalled();
  });

  it("eyebrow shows project key + count when configured + projectKey set", () => {
    useIssuesStore.setState({
      issues: [
        { key: "CLPNSNS-92", summary: "x", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "u", parentKey: null },
        { key: "CLPNSNS-105", summary: "y", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "u", parentKey: null },
        { key: "OTHER-1", summary: "z", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "u", parentKey: null },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    render(<BacklogPanel configured projectKey="CLPNSNS" activeKey={null} />);
    // Brass surgical: only the project key carries text-octo-brass; the count is
    // rendered as plain text in the mute eyebrow.
    const key = screen.getByText("CLPNSNS");
    expect(key).toHaveClass("text-octo-brass");
    expect(key.closest("button")?.textContent).toMatch(/CLPNSNS · 2/);
  });

  it("excludes the active key from the list", () => {
    useIssuesStore.setState({
      issues: [
        { key: "CLPNSNS-92", summary: "active", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: null, url: "u", parentKey: null },
        { key: "CLPNSNS-105", summary: "queued", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "u", parentKey: null },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    render(<BacklogPanel configured projectKey="CLPNSNS" activeKey="CLPNSNS-92" />);
    expect(screen.queryByText("active")).not.toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("when projectKey is null, shows (no project) in eyebrow and no issue rows", () => {
    useIssuesStore.setState({
      issues: [], loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    render(<BacklogPanel configured projectKey={null} activeKey={null} />);
    // Companion doesn't render BacklogPanel when projectKey is null, but if
    // it is rendered defensively, it shows "(no project)" in the eyebrow
    // and does not render any ticket rows or a "Link project" button.
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /link project/i })).not.toBeInTheDocument();
  });
});

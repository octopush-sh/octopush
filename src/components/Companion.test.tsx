import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Companion } from "./Companion";

// Minimal stubs for child components so the test focuses on structure.
vi.mock("./CompanionContext",   () => ({ CompanionContext:   () => <div data-testid="ctx" />   }));
vi.mock("./CompanionHistory",   () => ({ CompanionHistory:   () => <div data-testid="hist" />  }));
vi.mock("./CompanionTerminals", () => ({ CompanionTerminals: () => <div data-testid="term" />  }));
vi.mock("./CompanionFileTree",  () => ({ CompanionFileTree:  () => <div data-testid="tree" />  }));
vi.mock("./review/AiReviewPanel", () => ({ AiReviewPanel: () => <div data-testid="ai-review" /> }));
vi.mock("./WorkContextPanel",   () => ({ WorkContextPanel:   () => <div data-testid="backlog" /> }));
vi.mock("./ElsewhereFooter",    () => ({ ElsewhereFooter:    () => <div data-testid="else" />  }));

// Base props with a workspace whose branch encodes a Jira key so
// resolveJiraProjectKey returns a non-null value → the Jira block renders.
const baseProps = {
  workspaceId: "w1",
  contextProps: { tokensUsed: 0, tokensLimit: 0, unstaged: 0, toolCalls: 0 },
  historyProps: { chats: [], activeChatId: null, onSelectChat: vi.fn(), onNewChat: vi.fn() },
  issueTrackerConfigured: true,
  workspace: {
    id: "w1", projectId: "p1", name: "x", task: "", branch: "feat/CLPNSNS-1",
    worktreePath: null, setupScript: "", status: "active",
    createdAt: "", lastActive: "", glyph: null, tint: null, testCommand: null,
    linkedIssueKey: null,
    fromBranch: null,
  },
  // jiraProjectKey drives resolveJiraProjectKey — set it so projectKey != null
  project: { id: "p1", name: "Test", path: "/tmp/repo", jiraProjectKey: "CLPNSNS", pinned: false, tint: null },
  onModeChange: vi.fn(),
  collapsed: false,
  onToggleCollapsed: vi.fn(),
};

describe("Companion cross-mode visibility of issue tracker block", () => {
  it("renders BacklogPanel in TALK when projectKey is resolved", () => {
    render(<Companion mode="talk" {...baseProps} />);
    expect(screen.getByTestId("backlog")).toBeInTheDocument();
  });

  it("renders BacklogPanel in RUN when projectKey is resolved", () => {
    render(<Companion mode="run" {...baseProps} />);
    expect(screen.getByTestId("backlog")).toBeInTheDocument();
  });

  it("renders BacklogPanel in REVIEW when projectKey is resolved", () => {
    render(<Companion mode="review" {...baseProps} />);
    expect(screen.getByTestId("backlog")).toBeInTheDocument();
  });

  it("shows 'Make it a project' in TALK only when onMakeProject is wired (Sketchbook)", () => {
    const { rerender } = render(<Companion mode="talk" {...baseProps} />);
    expect(screen.queryByText("Make it a project")).not.toBeInTheDocument();
    rerender(<Companion mode="talk" {...baseProps} onMakeProject={vi.fn()} />);
    expect(screen.getByText("Make it a project")).toBeInTheDocument();
  });

  it("hides all Jira panels when projectKey is null", () => {
    const propsWithNoKey = {
      ...baseProps,
      // No jiraProjectKey and branch has no Jira key → projectKey resolves to null
      workspace: {
        ...baseProps.workspace,
        branch: "main",
        linkedIssueKey: null,
        fromBranch: null,
      },
      project: { id: "p1", name: "Test", path: "/tmp/repo", jiraProjectKey: null, pinned: false, tint: null },
    };
    render(<Companion mode="talk" {...propsWithNoKey} />);
    expect(screen.queryByTestId("active")).not.toBeInTheDocument();
    expect(screen.queryByTestId("backlog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("else")).not.toBeInTheDocument();
  });
});

describe("Companion collapse", () => {
  it("expanded: a collapse control toggles the parent state", () => {
    const onToggleCollapsed = vi.fn();
    render(<Companion mode="talk" {...baseProps} onToggleCollapsed={onToggleCollapsed} />);
    const btn = screen.getByRole("button", { name: /collapse companion/i });
    fireEvent.click(btn);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("collapsed: shows an expand control and a vertical mode switcher", () => {
    const onModeChange = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(
      <Companion
        mode="review"
        {...baseProps}
        collapsed
        onModeChange={onModeChange}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    // The expanded panel chrome is gone…
    expect(screen.queryByRole("button", { name: /collapse companion/i })).not.toBeInTheDocument();
    // …replaced by the expand control + a vertical mode switcher.
    fireEvent.click(screen.getByRole("button", { name: /expand companion/i }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^talk$/i }));
    expect(onModeChange).toHaveBeenCalledWith("talk");
  });
});

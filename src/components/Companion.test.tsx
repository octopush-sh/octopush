import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    render(<Companion mode="review" {...baseProps} fileTree={{ rootPath: "/", rootLabel: "/", changedPaths: new Set() }} />);
    expect(screen.getByTestId("backlog")).toBeInTheDocument();
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

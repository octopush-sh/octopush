import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Companion } from "./Companion";

// Mock child companions so they don't hit real store/IPC.
vi.mock("./CompanionTerminals", () => ({
  CompanionTerminals: ({ workspaceId }: { workspaceId: string }) => (
    <div>Terminals({workspaceId})</div>
  ),
}));

vi.mock("./CompanionFileTree", () => ({
  CompanionFileTree: ({ rootLabel }: { rootLabel: string }) => (
    <div>FileTree({rootLabel})</div>
  ),
}));

const defaultProps = {
  workspaceId: "ws-1",
  contextProps: { tokensUsed: 42000, tokensLimit: 200000, unstaged: 3, toolCalls: 7 },
  historyProps: { chats: [], activeChatId: null, onSelectChat: () => {}, onNewChat: () => {} },
};

const fileTree = {
  rootPath: "/repo",
  rootLabel: "my-project",
  changedPaths: new Set<string>(),
};

describe("Companion", () => {
  it("renders Context and History sections in talk mode", () => {
    render(<Companion mode="talk" {...defaultProps} />);
    expect(screen.getByText(/^context$/i)).toBeInTheDocument();
    expect(screen.getByText(/^history$/i)).toBeInTheDocument();
  });

  it("renders Terminals section in run mode", () => {
    render(<Companion mode="run" {...defaultProps} />);
    expect(screen.getByText(/Terminals/i)).toBeInTheDocument();
  });

  it("does not render Terminals when workspaceId is null in run mode", () => {
    render(<Companion mode="run" {...defaultProps} workspaceId={null} />);
    expect(screen.queryByText(/Terminals/i)).not.toBeInTheDocument();
  });

  it("renders FileTree in review mode when fileTree prop is provided", () => {
    render(<Companion mode="review" {...defaultProps} fileTree={fileTree} />);
    expect(screen.getByText(/FileTree\(my-project\)/i)).toBeInTheDocument();
  });

  it("renders nothing in review mode when fileTree prop is absent", () => {
    render(<Companion mode="review" {...defaultProps} />);
    // Should not render any content in the companion aside beyond the container
    expect(screen.queryByText(/FileTree/i)).not.toBeInTheDocument();
  });
});

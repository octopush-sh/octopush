/**
 * Companion → Conversation → "follows": the instruction files Talk and its
 * sub-agents follow (the worktree's CLAUDE.md chain, or AGENTS.md), with each
 * file's tokens in the tooltip, re-read when a turn starts or settles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { InstructionFile } from "../lib/types";

const listProjectInstructions = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    listProjectInstructions: (...a: unknown[]) => listProjectInstructions(...a),
  },
}));

import { useChatStore } from "../stores/chatStore";
import { CompanionInstructions, instructionsTitle } from "./CompanionInstructions";

const claude: InstructionFile = { label: "CLAUDE.md", path: "/wt/CLAUDE.md", tokens: 3100, trimmed: false };
const user: InstructionFile = { label: "~/.claude/CLAUDE.md", path: "/Users/dev/.claude/CLAUDE.md", tokens: 850, trimmed: false };

async function mount(worktreePath = "/wt") {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CompanionInstructions worktreePath={worktreePath} workspaceId="ws" />);
  });
  return view;
}

beforeEach(() => {
  listProjectInstructions.mockReset().mockResolvedValue([user, claude]);
  useChatStore.setState({ streamingByWs: {} });
});

describe("instructionsTitle", () => {
  it("says what the files are, then each one's tokens or why it wasn't sent whole", () => {
    const title = instructionsTitle([
      user,
      { ...claude, tokens: 4000, trimmed: true },
      { label: "CLAUDE.local.md", path: "/wt/CLAUDE.local.md", tokens: 0, trimmed: true },
    ]);
    expect(title.split("\n")).toEqual([
      "Talk and its sub-agents follow these files, read again on every turn: the CLAUDE.md chain Claude Code loads, or AGENTS.md when there is no CLAUDE.md.",
      "~/.claude/CLAUDE.md · 850 tokens",
      "CLAUDE.md · 4k tokens · trimmed to fit",
      "CLAUDE.local.md · left out, the instructions were already at their limit",
    ]);
  });
});

describe("CompanionInstructions", () => {
  it("names each file in load order, with the details in the tooltip", async () => {
    await mount();
    expect(listProjectInstructions).toHaveBeenCalledWith("/wt");
    const row = screen.getByTestId("companion-follows");
    expect(row).toHaveAttribute("data-tour", "companion-follows");
    expect(row).toHaveTextContent("follows~/.claude/CLAUDE.mdCLAUDE.md");
    expect(row.getAttribute("title")).toContain("CLAUDE.md · 3k tokens");
  });

  it("is hidden when the worktree has no instruction file", async () => {
    listProjectInstructions.mockResolvedValue([]);
    await mount();
    expect(screen.queryByTestId("companion-follows")).toBeNull();
  });

  it("is hidden without a worktree, and asks nothing", async () => {
    await act(async () => {
      render(<CompanionInstructions workspaceId="ws" />);
    });
    expect(listProjectInstructions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("companion-follows")).toBeNull();
  });

  it("re-reads when a turn starts and settles, so an edited file shows", async () => {
    await mount();
    expect(listProjectInstructions).toHaveBeenCalledTimes(1);
    listProjectInstructions.mockResolvedValue([claude]);
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: true } });
    });
    await act(async () => {
      useChatStore.setState({ streamingByWs: { ws: false } });
    });
    expect(listProjectInstructions).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("companion-follows")).not.toHaveTextContent("~/.claude");
  });

  it("drops a late answer for the worktree it left", async () => {
    let answerOld!: (f: InstructionFile[]) => void;
    listProjectInstructions.mockImplementationOnce(() => new Promise((r) => (answerOld = r)));
    const view = await mount("/old");
    listProjectInstructions.mockResolvedValue([claude]);
    await act(async () => {
      view.rerender(<CompanionInstructions worktreePath="/new" workspaceId="ws" />);
    });
    await act(async () => {
      answerOld([user]);
    });
    expect(screen.getByTestId("companion-follows")).toHaveTextContent("followsCLAUDE.md");
    expect(screen.getByTestId("companion-follows")).not.toHaveTextContent("~/.claude");
  });
});

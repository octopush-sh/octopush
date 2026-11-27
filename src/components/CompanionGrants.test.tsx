/**
 * Companion → Conversation → "allowed" (#1229): the open conversation's
 * grants, each with a revoke button; re-read when a card keeps one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { TalkGrant } from "../lib/ipc";

const listThreadGrants = vi.fn();
const revokeThreadGrant = vi.fn();
const grantListeners: Array<(threadId: string) => void> = [];
vi.mock("../lib/ipc", () => ({
  ipc: {
    listThreadGrants: (...a: unknown[]) => listThreadGrants(...a),
    revokeThreadGrant: (...a: unknown[]) => revokeThreadGrant(...a),
    onGrantsChanged: (h: (threadId: string) => void) => {
      grantListeners.push(h);
      return Promise.resolve(() => {});
    },
  },
}));

import { useChatStore } from "../stores/chatStore";
import { CompanionGrants, grantTitle } from "./CompanionGrants";

const read: TalkGrant = { kind: "read", value: "/Users/me/notes", shown: "~/notes" };
const cmd: TalkGrant = { kind: "command", value: '["wnpm","wtest"]', shown: "npm test" };

async function mount() {
  await act(async () => {
    render(<CompanionGrants workspaceId="ws" />);
  });
}

beforeEach(() => {
  grantListeners.length = 0;
  listThreadGrants.mockReset().mockResolvedValue([]);
  revokeThreadGrant.mockReset();
  useChatStore.setState({ activeThreadByWs: { ws: "t-1" } });
});

describe("CompanionGrants", () => {
  it("is hidden while the conversation holds no grant", async () => {
    await mount();
    expect(screen.queryByTestId("companion-grants")).toBeNull();
    expect(listThreadGrants).toHaveBeenCalledWith("t-1");
  });

  it("lists the grants and revokes one with a click", async () => {
    listThreadGrants.mockResolvedValue([read, cmd]);
    revokeThreadGrant.mockResolvedValue([cmd]);
    await mount();
    expect(screen.getByTestId("companion-grants")).toHaveAttribute("data-tour", "companion-grants");
    expect(screen.getByText("~/notes").parentElement).toHaveAttribute("title", "Commands read in ~/notes without asking");
    expect(screen.getByText("npm test")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Revoke: ${grantTitle(read)}` }));
    });
    expect(revokeThreadGrant).toHaveBeenCalledWith("t-1", read);
    expect(screen.queryByText("~/notes")).toBeNull();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("re-reads when a card keeps a grant in this conversation only", async () => {
    await mount();
    listThreadGrants.mockResolvedValue([cmd]);
    await act(async () => {
      grantListeners.forEach((h) => h("t-other"));
    });
    expect(screen.queryByText("npm test")).toBeNull();
    await act(async () => {
      grantListeners.forEach((h) => h("t-1"));
    });
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("says what each kind lets the conversation do", () => {
    expect(grantTitle({ kind: "write", value: "/tmp/out", shown: "/tmp/out" })).toBe("The file tools write in /tmp/out without asking");
    expect(grantTitle(cmd)).toBe("Runs without asking: npm test");
  });
});

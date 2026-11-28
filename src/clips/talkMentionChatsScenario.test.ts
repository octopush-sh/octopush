// The `talk-mention-chats` clip scenario (#1162): its changeset points at the
// @ popover's Conversations and Definitions groups, which only render when
// the active workspace has another conversation and the search finds a
// definition. The scenario must give the composer both.
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "./dispatcher";
import { SCENARIOS } from "../../scripts/clips/scenarios";
import { DEFAULT_FIXTURES } from "../../scripts/clips/scenarios/default";
import type { ChatThread } from "../lib/types";

const scenario = SCENARIOS["talk-mention-chats"];
const { handle } = createDispatcher(scenario);

vi.mock("../lib/ipc", () => ({
  ipc: {
    searchWorkspaceText: async (workspacePath: string, query: string, caseSensitive: boolean, wholeWord: boolean) =>
      handle("search_workspace_text", { workspacePath, query, caseSensitive, wholeWord }),
    readFileLines: async (path: string, start: number, end: number, maxBytes: number) =>
      handle("read_file_lines", { path, start, end, maxBytes }),
  },
}));

const { findSymbolRows } = await import("../lib/talkSymbols");
const { chatRefs, contextMentionItems, dirsOf, formatChatDigest } = await import("../lib/talkContext");

const ACTIVE = DEFAULT_FIXTURES.WORKSPACES[1];
const ROOT = ACTIVE.worktreePath ?? "";

describe("talk-mention-chats scenario", () => {
  it("is registered and keeps the default conversation open", () => {
    expect(scenario.name).toBe("talk-mention-chats");
    const threads = handle("list_chat_threads", { workspaceId: ACTIVE.id }) as ChatThread[];
    // The store opens the first thread listed.
    expect(threads[0].id).toBe(DEFAULT_FIXTURES.THREAD.id);
    expect(threads.map((t) => t.title)).toContain("Auth refactor");
  });

  it("lists another conversation under @chat:, with a digest to attach", () => {
    const threads = handle("list_chat_threads", { workspaceId: ACTIVE.id }) as ChatThread[];
    const chats = chatRefs(threads, threads[0].id);
    const files = handle("list_workspace_files", { workspacePath: ROOT }) as string[];
    expect(contextMentionItems("chat:", files, dirsOf(files), [], chats)).toEqual(["chat:auth-refactor"]);
    const auth = chats.find((c) => c.slug === "auth-refactor")!;
    const digest = handle("chat_thread_digest", { workspaceId: ACTIVE.id, threadId: auth.id }) as Parameters<
      typeof formatChatDigest
    >[0];
    expect(digest.asks).toHaveLength(1);
    expect(formatChatDigest(digest)).toContain("## Last answer");
    // Another workspace reads nothing.
    const other = handle("chat_thread_digest", { workspaceId: "ws-main", threadId: auth.id }) as typeof digest;
    expect(other.asks).toEqual([]);
  });

  it("finds where parseToken is defined, as a line range", async () => {
    const files = handle("list_workspace_files", { workspacePath: ROOT }) as string[];
    const rows = await findSymbolRows(ROOT, "parseToken", new Set(files));
    expect(rows.map((r) => r.token)).toEqual(["src/lib/tokens.ts#L10-14"]);
  });
});

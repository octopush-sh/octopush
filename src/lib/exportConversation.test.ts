import { describe, it, expect } from "vitest";
import { conversationToMarkdown } from "./exportConversation";
import type { ChatMessage } from "./types";

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1, workspaceId: "ws", role: "user", content: "", model: null,
    inputTokens: null, outputTokens: null, costUsd: null, createdAt: "", ...over,
  };
}

describe("conversationToMarkdown", () => {
  it("renders user + assistant turns under labeled headings", () => {
    const md = conversationToMarkdown("My chat", [
      msg({ id: 1, role: "user", content: "hello" }),
      msg({ id: 2, role: "assistant", content: "hi there", model: "claude-sonnet-4-6" }),
    ]);
    expect(md).toContain("# My chat");
    expect(md).toContain("## You");
    expect(md).toContain("hello");
    expect(md).toContain("## Octopus");
    expect(md).toContain("claude-sonnet-4-6");
    expect(md).toContain("hi there");
  });

  it("renders a run_command tool row with its command and result", () => {
    const md = conversationToMarkdown("X", [
      msg({
        id: 1,
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          toolInput: { command: "npm test" },
          result: "ok",
        }),
      }),
    ]);
    expect(md).toContain("§ RUN_COMMAND");
    expect(md).toContain("$ npm test");
    expect(md).toContain("ok");
  });

  it("does not throw on a non-JSON tool row", () => {
    const md = conversationToMarkdown("X", [msg({ id: 1, role: "tool", content: "raw blob" })]);
    expect(md).toContain("raw blob");
  });
});

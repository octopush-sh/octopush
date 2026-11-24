import { describe, it, expect } from "vitest";
import { groupWork, toolCallCount, ROUND_FOLD_AT } from "./talkWork";
import type { ConversationItem, ToolExecution } from "../stores/chatStore";
import type { ChatMessage } from "./types";

const msg = (id: number, role: ChatMessage["role"]): ConversationItem => ({
  kind: "message",
  message: { id, workspaceId: "ws", role, content: `m${id}`, model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: "2026-11-24T14:02:00Z" },
});
const tool = (id: number, toolName = "read_file"): ConversationItem => ({
  kind: "tool",
  id,
  tool: { toolName, toolInput: { path: `src/f${id}.ts` }, result: "" } satisfies ToolExecution,
});
const narr = (id: number): ConversationItem => ({ kind: "narration", id, text: `n${id}`, model: "m" });

describe("groupWork — the model's work as one block per run", () => {
  it("joins narration and tool calls in a row into one work block, rounds split by narration", () => {
    const blocks = groupWork([msg(1, "user"), narr(2), tool(3), tool(4), tool(5), narr(6), tool(7), tool(8), msg(9, "assistant")]);
    expect(blocks.map((b) => b.kind)).toEqual(["message", "work", "message"]);
    const work = blocks[1];
    if (work.kind !== "work") throw new Error("expected work");
    expect(work.id).toBe(2);
    expect(work.calls).toBe(5);
    expect(work.entries.map((e) => (e.kind === "round" ? `round:${e.tools.map((t) => t.id).join(",")}` : `narration:${e.id}`))).toEqual([
      "narration:2",
      "round:3,4,5",
      "narration:6",
      "round:7,8",
    ]);
  });

  it("starts a block on a tool call with no narration before it", () => {
    const blocks = groupWork([msg(1, "user"), tool(2), tool(3), msg(4, "assistant")]);
    const work = blocks[1];
    expect(work.kind === "work" && work.id).toBe(2);
    expect(work.kind === "work" && work.entries).toHaveLength(1);
  });

  it("keeps a narration-only block (no calls yet) and counts zero calls", () => {
    const blocks = groupWork([msg(1, "user"), narr(2)]);
    expect(blocks[1]).toMatchObject({ kind: "work", calls: 0 });
  });

  it("lets every other item end the run: a message, a crew, an error", () => {
    const crew: ConversationItem = { kind: "crew", id: 4, agents: [] };
    const error: ConversationItem = { kind: "error", message: (msg(7, "error") as { message: ChatMessage }).message };
    const blocks = groupWork([tool(1), tool(2), msg(3, "assistant"), crew, tool(5), error, narr(8), tool(9)]);
    expect(blocks.map((b) => b.kind)).toEqual(["work", "message", "crew", "work", "error", "work"]);
    expect(blocks.filter((b) => b.kind === "work").map((b) => b.kind === "work" && b.calls)).toEqual([2, 1, 1]);
  });

  it("passes a conversation with no work through unchanged", () => {
    const items = [msg(1, "user"), msg(2, "assistant")];
    expect(groupWork(items)).toEqual(items);
  });

  it("folds at more than five calls", () => {
    expect(ROUND_FOLD_AT).toBe(5);
  });
});

describe("toolCallCount", () => {
  it("counts in English", () => {
    expect(toolCallCount(1)).toBe("1 tool call");
    expect(toolCallCount(7)).toBe("7 tool calls");
  });
});

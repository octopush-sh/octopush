import { describe, expect, it } from "vitest";
import { bannerErrorKind, errorAction, errorKindOf, keptLine, roundsKept } from "./talkError";
import type { ChatMessage } from "./types";

const row = (id: number, role: string): ChatMessage =>
  ({ id, workspaceId: "ws", role, content: "", model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: "" }) as ChatMessage;

describe("talkError", () => {
  it("reads an absent or unknown kind as other", () => {
    expect(errorKindOf(undefined)).toBe("other");
    expect(errorKindOf(null)).toBe("other");
    expect(errorKindOf("teapot")).toBe("other");
    expect(errorKindOf("spend_cap")).toBe("spend_cap");
  });

  it("retries only what can clear on its own", () => {
    expect(["rate_limit", "overloaded", "server_error", "network"].map((k) => errorAction(errorKindOf(k)))).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
    ]);
    expect(errorAction("auth")).toBe("configure");
    expect(errorAction("spend_cap")).toBe("copy");
    expect(errorAction("bad_request")).toBe("copy");
    expect(errorAction("other")).toBe("copy");
  });

  it("counts the failed turn's rounds back to its ask, retries included", () => {
    const msgs = [
      row(1, "user"),
      row(2, "assistant_tool_use"),
      row(3, "assistant"),
      row(4, "user"),
      row(5, "assistant_tool_use"),
      row(6, "tool"),
      row(7, "error"),
      row(8, "assistant_tool_use"),
      row(9, "error"),
    ];
    expect(roundsKept(msgs, 6)).toBe(1);
    expect(roundsKept(msgs, 8)).toBe(2);
    expect(keptLine(2)).toBe("Work up to round 2 is kept.");
    expect(keptLine(0)).toBe("Your message is kept.");
  });

  it("reads a refused send's text for the API key", () => {
    expect(bannerErrorKind("anthropic API key not configured.")).toBe("auth");
    expect(bannerErrorKind("Could not start a conversation.")).toBe("other");
  });
});

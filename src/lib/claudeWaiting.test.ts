/** Claude Code hook signals: the reason filter, the shared copy, and the
 *  notification decision. */
import { describe, it, expect } from "vitest";
import { claudeWaitReason, claudeWaitingCopy, decideClaudeWaitingNotification } from "./claudeWaiting";

describe("claudeWaitReason", () => {
  it("keeps only the hooks' own reasons", () => {
    expect(claudeWaitReason("permission")).toBe("permission");
    expect(claudeWaitReason("input")).toBe("input");
    expect(claudeWaitReason("idle")).toBeNull();
    expect(claudeWaitReason(null)).toBeNull();
    expect(claudeWaitReason(undefined)).toBeNull();
  });
});

describe("claudeWaitingCopy", () => {
  it("names what Claude Code is waiting on", () => {
    expect(claudeWaitingCopy("permission")).toBe("waiting on permission");
    expect(claudeWaitingCopy("input")).toBe("waiting on your input");
  });
});

describe("decideClaudeWaitingNotification", () => {
  it("names the workspace and the reason", () => {
    expect(decideClaudeWaitingNotification("permission", "checkout-flow", false)).toEqual({
      title: "Claude Code needs you",
      body: "checkout-flow — waiting on permission",
    });
    expect(decideClaudeWaitingNotification("input", null, false)?.body).toBe("a workspace — waiting on your input");
  });

  it("stays quiet while the user is looking at the terminal", () => {
    expect(decideClaudeWaitingNotification("permission", "ws", true)).toBeNull();
  });
});
